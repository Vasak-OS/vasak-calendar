<script lang="ts" setup>
/**
 * La grilla horaria de día, N días y semana: un eje de horas a la izquierda, una
 * columna por día y cada evento como un bloque que ocupa de su comienzo a su
 * fin. Es la vista de la ventana ancha; con la angosta queda `ColumnsView`
 * (la lista por día), igual que el mes con `MonthGrid` y `MonthAgenda`.
 *
 * Todo lo que dice o posiciona una hora sale de la zona de la agenda (`zone`),
 * nunca del reloj del sistema: la cuenta está en `tools/time-grid.ts`. Los
 * eventos de todo el día van en una franja arriba, y la línea de «ahora» se
 * dibuja en la columna de hoy, también en esa zona.
 *
 * Un bloque con ETag se arrastra para moverlo (también a otro día) y se estira
 * por su borde de abajo, con pointer events (no HTML5 drag-and-drop, que no
 * anda bien en WebKitGTK ni con el tacto). La geometría y el parche viven en
 * `tools/time-grid.ts`; acá sólo se sigue el puntero y, al soltar, se emite
 * `change` con el comienzo y el fin nuevos. Un toque sin pasar `DRAG_THRESHOLD_PX`
 * sigue abriendo el evento. Los de todo el día no se arrastran todavía.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { Panel } from '@vasakgroup/vue-libvasak';
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import DayColumnHeader from '@/components/calendar/DayColumnHeader.vue';
import EventLabel from '@/components/calendar/EventLabel.vue';
import { eventSpanOn } from '@/tools/agenda';
import { markColor } from '@/tools/event-categories';
import { interpolar } from '@/tools/interpolar';
import type { CalendarEvent } from '@/tools/mes';
import {
	allDayOf,
	type DragMode,
	draggedValues,
	dragRange,
	isDraggableOn,
	MINUTES_PER_DAY,
	type MinuteRange,
	minutesOfDay,
	type PlacedEvent,
	placeEvents,
} from '@/tools/time-grid';
import type { DayRangeProps } from '@/tools/views';
import { civilDe, claveCivil } from '@/tools/zona';

const props = defineProps<DayRangeProps>();
const emit = defineEmits<{
	open: [event: CalendarEvent];
	/** Un evento movido o estirado: valores de comienzo y fin como los del formulario. */
	change: [value: { event: CalendarEvent; start: string; end: string | null }];
}>();

const { t, locale } = useI18n();

/** Un píxel por minuto: una hora son 60 px y el día entero 1440. */
const PX_PER_MINUTE = 1;
/** Alto mínimo de un bloque, para que uno corto se pueda tocar (32 px). */
const MIN_BLOCK_PX = 32;
/** A qué hora arranca el scroll: lo que se mira casi siempre es la jornada. */
const FIRST_VISIBLE_HOUR = 8;
/** Cuánto hay que mover el puntero para que un toque pase a ser un arrastre. */
const DRAG_THRESHOLD_PX = 4;

const hours = Array.from({ length: 24 }, (_, hour) => hour);
const bodyHeight = { height: `${MINUTES_PER_DAY * PX_PER_MINUTE}px` };

const timeFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			hour: '2-digit',
			minute: '2-digit',
			timeZone: props.zone,
		})
);
// La etiqueta del eje es una hora de reloj sin zona: se formatea en UTC para que
// «9» diga 9 sea cual sea la zona del sistema.
const axisFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
);
const fullDayFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeZone: props.zone })
);

function axisLabel(minutes: number): string {
	return axisFormat.value.format(new Date(Date.UTC(2000, 0, 1, 0, minutes)));
}

const columns = computed(() => ({
	gridTemplateColumns: `repeat(${Math.max(props.days.length, 1)}, minmax(0, 1fr))`,
}));

/** Cada día con sus bloques ubicados y su franja de todo el día. */
const columnsData = computed(() =>
	props.days.map((day) => {
		const events = props.eventsOf(day.clave);
		return {
			day,
			allDay: allDayOf(events, day.clave, props.zone),
			placed: placeEvents(events, day.clave, props.zone, MIN_BLOCK_PX / PX_PER_MINUTE),
		};
	})
);

function titleOf(event: CalendarEvent): string {
	return event.title.trim() || t('calendario.sinTitulo');
}

/** La hora de un evento ese día, entera, según qué parte cae ahí. */
function timeOf(event: CalendarEvent, dayKey: string): string {
	const span = eventSpanOn(event, dayKey, props.zone);
	const time = timeFormat.value;
	switch (span.kind) {
		case 'range':
			return interpolar(t('agenda.range'), time.format(span.start), time.format(span.end));
		case 'from':
			return interpolar(t('agenda.from'), time.format(span.start));
		case 'at':
			return time.format(span.start);
		case 'until':
			return interpolar(t('agenda.until'), time.format(span.end));
		default:
			return t('calendario.todoElDia');
	}
}

function descriptionOf(event: CalendarEvent, dayKey: string): string {
	const base = interpolar(t('calendario.eventosDelDia'), timeOf(event, dayKey), titleOf(event));
	return event.zone && event.zone !== props.zone
		? `${base} — ${interpolar(t('calendario.escritoEn'), event.zone)}`
		: base;
}

function blockStyle(p: { startMin: number; endMin: number; column: number; columns: number }) {
	return {
		top: `${p.startMin * PX_PER_MINUTE}px`,
		height: `${(p.endMin - p.startMin) * PX_PER_MINUTE}px`,
		left: `${(p.column / p.columns) * 100}%`,
		width: `${100 / p.columns}%`,
	};
}

/** El arrastre en curso: qué bloque, en qué modo y a dónde va la vista previa. */
interface Drag {
	p: PlacedEvent;
	dayKey: string;
	mode: DragMode;
	x: number;
	y: number;
	moved: boolean;
	/** La columna y el tramo donde cae ahora. */
	target: { dayKey: string; range: MinuteRange };
}
const drag = shallowRef<Drag | null>(null);
const columnsEl = ref<HTMLElement | null>(null);
// El click que sigue a un arrastre no tiene que abrir el evento.
let suppressClick = false;

const draggable = (p: PlacedEvent, dayKey: string) => isDraggableOn(p.event, dayKey, props.zone);

function startDrag(e: PointerEvent, p: PlacedEvent, dayKey: string, mode: DragMode) {
	if (e.button !== 0 || !draggable(p, dayKey)) return;
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	drag.value = {
		p,
		dayKey,
		mode,
		x: e.clientX,
		y: e.clientY,
		moved: false,
		target: { dayKey, range: p },
	};
}

/** La columna bajo el puntero, para mover de día. */
function dayUnder(clientX: number, fallback: string): string {
	const box = columnsEl.value?.getBoundingClientRect();
	if (!box || box.width === 0) return fallback;
	const index = Math.floor(((clientX - box.left) / box.width) * props.days.length);
	return props.days[Math.min(Math.max(index, 0), props.days.length - 1)].clave;
}

function moveDrag(e: PointerEvent) {
	const d = drag.value;
	if (!d) return;
	const dy = e.clientY - d.y;
	const moved = d.moved || Math.hypot(e.clientX - d.x, dy) >= DRAG_THRESHOLD_PX;
	if (!moved) return;
	drag.value = {
		...d,
		moved,
		target: {
			dayKey: d.mode === 'move' ? dayUnder(e.clientX, d.dayKey) : d.dayKey,
			range: dragRange(d.mode, d.p, dy / PX_PER_MINUTE),
		},
	};
}

function endDrag(commit: boolean) {
	const d = drag.value;
	drag.value = null;
	if (!d?.moved) return;
	suppressClick = true;
	setTimeout(() => {
		suppressClick = false;
	}, 0);
	const { dayKey, range } = d.target;
	if (
		!commit ||
		(dayKey === d.dayKey && range.startMin === d.p.startMin && range.endMin === d.p.endMin)
	) {
		return;
	}
	emit('change', {
		event: d.p.event,
		...draggedValues(d.mode, d.p.event, props.zone, dayKey, range),
	});
}

function onBlockClick(event: CalendarEvent) {
	if (!suppressClick) emit('open', event);
}

/** La vista previa: el tramo nuevo, sólo en la columna donde cae. */
const ghostOn = (dayKey: string) =>
	drag.value?.moved && drag.value.target.dayKey === dayKey ? drag.value : null;

// «Ahora», en la zona de la agenda. Se refresca cada minuto.
const now = ref(new Date());
const todayKey = computed(() => claveCivil(civilDe(now.value, props.zone)));
const nowTop = computed(() => `${minutesOfDay(now.value, props.zone) * PX_PER_MINUTE}px`);
let timer: ReturnType<typeof setInterval> | undefined;

const scroller = ref<HTMLElement | null>(null);
let desplazada = false;
let observer: ResizeObserver | null = null;

/**
 * Lleva el scroll a la primera hora visible, una sola vez y sólo cuando la
 * grilla ya tiene alto. Con `WIDE_ONLY` la grilla puede estar oculta al montar
 * (`display:none`, alto 0), y `scrollTop` sobre algo sin alto no hace nada; en
 * WebKitGTK ni `resize` ni `matchMedia` avisan de que se volvió visible, así que
 * lo escucha un `ResizeObserver` sobre el propio desplazador.
 */
function desplazarAlInicio(): void {
	const el = scroller.value;
	if (!el || desplazada || el.clientHeight === 0) return;
	el.scrollTop = FIRST_VISIBLE_HOUR * 60 * PX_PER_MINUTE;
	desplazada = true;
	observer?.disconnect();
}

onMounted(() => {
	desplazarAlInicio();
	if (scroller.value && !desplazada) {
		observer = new ResizeObserver(() => desplazarAlInicio());
		observer.observe(scroller.value);
	}
	timer = setInterval(() => {
		now.value = new Date();
	}, 60_000);
});
onUnmounted(() => {
	clearInterval(timer);
	observer?.disconnect();
});

// El scroll se reserva siempre: así la cabecera y el cuerpo miden lo mismo.
const gutter = { scrollbarGutter: 'stable' };
</script>

<template>
  <Panel padding="none" class="min-h-0 flex-1 overflow-hidden">
    <div class="flex h-full min-h-0 flex-col" data-testid="time-grid">
      <!-- Cabecera: el día y, si alguno lo tiene, la franja de todo el día. -->
      <div class="shrink-0 overflow-y-hidden border-ui-line-weak border-b" :style="gutter">
        <div class="flex">
          <div class="w-12 shrink-0"></div>
          <div class="grid min-w-0 flex-1" :style="columns">
            <div
              v-for="{ day, allDay } in columnsData"
              :key="day.clave"
              role="group"
              class="flex min-w-0 flex-col gap-1 border-ui-line-weak border-l p-1"
              :data-day="day.clave"
              :aria-current="day.clave === todayKey ? 'date' : undefined"
              :aria-label="fullDayFormat.format(day.fecha)">
              <div class="flex items-center justify-center gap-1">
                <DayColumnHeader
                  :fecha="day.fecha"
                  :is-today="day.clave === todayKey"
                  :zone="zone" />
              </div>
              <button
                v-for="event in allDay"
                :key="`${event.uid}-${event.start}`"
                type="button"
                class="flex min-h-8 min-w-0 items-center gap-1 rounded-corner-xs bg-ui-surface/60 px-1 text-left text-xs"
                :title="descriptionOf(event, day.clave)"
                :aria-label="descriptionOf(event, day.clave)"
                data-testid="all-day-event"
                @click="emit('open', event)">
                <span
                  class="h-3 w-1 shrink-0 rounded-corner-full"
                  :style="{ backgroundColor: markColor(event) ?? 'var(--color-primary)' }"
                  aria-hidden="true"></span>
                <EventLabel :event="event" :zone="zone" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Cuerpo: el eje de horas y las columnas, con scroll vertical. -->
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto" :style="gutter">
        <div class="flex" :style="bodyHeight">
          <div class="relative w-12 shrink-0" aria-hidden="true">
            <span
              v-for="hour in hours.slice(1)"
              :key="hour"
              class="-translate-y-1/2 absolute right-1 text-label-xs text-tx-muted tabular-nums"
              :style="{ top: `${hour * 60 * PX_PER_MINUTE}px` }">
              {{ axisLabel(hour * 60) }}
            </span>
          </div>
          <div class="relative min-w-0 flex-1">
            <div class="absolute inset-0" aria-hidden="true">
              <div
                v-for="hour in hours.slice(1)"
                :key="hour"
                class="absolute inset-x-0 border-ui-line-weak border-t"
                :style="{ top: `${hour * 60 * PX_PER_MINUTE}px` }"></div>
            </div>
            <div ref="columnsEl" class="grid h-full" :style="columns">
              <div
                v-for="{ day, placed } in columnsData"
                :key="day.clave"
                role="group"
                class="relative min-w-0 border-ui-line-weak border-l"
                :data-day-column="day.clave"
                :aria-label="fullDayFormat.format(day.fecha)">
                <button
                  v-for="p in placed"
                  :key="`${p.event.uid}-${p.event.start}`"
                  type="button"
                  class="absolute flex min-w-0 flex-col overflow-hidden rounded-corner-xs border border-ui-line bg-ui-surface px-1 text-left text-xs"
                  :class="[
                    draggable(p, day.clave) ? 'cursor-move touch-none' : 'cursor-not-allowed',
                    drag?.moved && drag.p === p ? 'opacity-40' : '',
                  ]"
                  :style="blockStyle(p)"
                  :title="descriptionOf(p.event, day.clave)"
                  :aria-label="descriptionOf(p.event, day.clave)"
                  data-testid="time-block"
                  @pointerdown="startDrag($event, p, day.clave, 'move')"
                  @pointermove="moveDrag"
                  @pointerup="endDrag(true)"
                  @pointercancel="endDrag(false)"
                  @click="onBlockClick(p.event)">
                  <!-- El color del calendario es dato del servidor: va como marca
                       al costado, nunca de fondo. Sin color, el acento. -->
                  <span
                    class="absolute inset-y-0 left-0 w-1"
                    :style="{ backgroundColor: markColor(p.event) ?? 'var(--color-primary)' }"
                    aria-hidden="true"
                    data-testid="event-color"></span>
                  <span class="flex min-w-0 items-center gap-1 pl-1" aria-hidden="true">
                    <EventLabel :event="p.event" :zone="zone" bold />
                  </span>
                  <span class="truncate pl-1 text-tx-muted tabular-nums" aria-hidden="true">
                    {{ timeOf(p.event, day.clave) }}
                  </span>
                  <!-- La manija del borde de abajo: estira el fin. -->
                  <span
                    v-if="draggable(p, day.clave)"
                    class="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize"
                    aria-hidden="true"
                    data-testid="resize-handle"
                    @pointerdown.stop="startDrag($event, p, day.clave, 'resize')"></span>
                </button>
                <!-- La vista previa del arrastre, con el mismo paso que se va a guardar. -->
                <div
                  v-if="ghostOn(day.clave)"
                  class="pointer-events-none absolute z-10 overflow-hidden rounded-corner-xs border border-primary bg-primary/30 px-1 text-xs tabular-nums"
                  :style="blockStyle({ ...ghostOn(day.clave)!.target.range, column: 0, columns: 1 })"
                  aria-hidden="true"
                  data-testid="drag-ghost">
                  {{ axisLabel(ghostOn(day.clave)!.target.range.startMin) }}
                  – {{ axisLabel(ghostOn(day.clave)!.target.range.endMin % MINUTES_PER_DAY) }}
                </div>
                <!-- La línea de «ahora», sólo en la columna de hoy. -->
                <div
                  v-if="day.clave === todayKey"
                  class="pointer-events-none absolute inset-x-0 h-0.5 bg-primary"
                  :style="{ top: nowTop }"
                  aria-hidden="true"
                  data-testid="now-line"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Panel>
</template>
