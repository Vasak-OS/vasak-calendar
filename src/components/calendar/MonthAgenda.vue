<script lang="ts" setup>
/**
 * El mes como agenda, para la ventana angosta (ver `tools/agenda.ts`).
 *
 * Recibe lo mismo que la cuadrícula —los días, la zona y de dónde sacar los
 * eventos de cada uno— para que las dos vistas sean del mismo mes siempre: la
 * que no se ve queda montada y oculta por CSS, así que al ensanchar o angostar
 * la ventana se ve el mismo mes, con la misma zona, sin volver a cargar nada.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import {
	EmptyState,
	ListGroup,
	ListRow,
	Panel,
	SectionHeading,
	StatusDot,
	ThemeIcon,
} from '@vasakgroup/vue-libvasak';
import { computed, ref } from 'vue';
import { agendaSections, eventSpanOn, isAgendaEmpty, todaySectionKey } from '@/tools/agenda';
import { interpolar } from '@/tools/interpolar';
import type { CalendarEvent, Dia } from '@/tools/mes';

const props = defineProps<{
	days: Dia[];
	/** En qué zona se está mirando la agenda. Todo lo que dice una hora la usa. */
	zone: string;
	eventsOf: (key: string) => CalendarEvent[];
}>();

const { t, locale } = useI18n();

const sections = computed(() => agendaSections(props.days, props.eventsOf));
const empty = computed(() => isAgendaEmpty(sections.value));

const timeFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			hour: '2-digit',
			minute: '2-digit',
			timeZone: props.zone,
		})
);

/** «jueves, 1 de octubre»: sin el año, que ya está en el título del mes. */
const dayFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			timeZone: props.zone,
		})
);

function headingOf(day: Dia): string {
	const date = dayFormat.value.format(day.fecha);
	return day.esHoy ? interpolar(t('agenda.today'), date) : date;
}

function titleOf(event: CalendarEvent): string {
	return event.title.trim() || t('calendario.sinTitulo');
}

/** La hora, entera: lo que la cuadrícula angosta cortaba. */
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

function foreignZoneOf(event: CalendarEvent): string {
	return event.zone && event.zone !== props.zone ? event.zone : '';
}

function recurrenceNoteOf(event: CalendarEvent): string {
	return event.shown_once
		? `${t('calendario.recurring')} — ${t('calendario.shownOnce')}`
		: t('calendario.recurring');
}

const scroller = ref<HTMLElement | null>(null);

/**
 * Lleva la lista al día de hoy, con su título arriba de todo.
 *
 * Con `scrollTo` sobre la lista y no con `scrollIntoView` sobre el día: el
 * segundo desplaza también a los antepasados que puedan desplazarse, y con la
 * ventana entera moviéndose la barra se iría para arriba. La lista es
 * `relative` para que `offsetTop` cuente desde ella.
 */
function showToday() {
	const list = scroller.value;
	const today = props.days.find((day) => day.esHoy);
	if (!list || !today) return;
	const key = todaySectionKey(sections.value, today.clave);
	const target = list.querySelector<HTMLElement>(`[data-day="${key}"]`);
	if (target) list.scrollTo({ top: target.offsetTop });
}

defineExpose({ showToday });
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col rounded-corner-l bg-ui-bg">
    <Panel padding="none" class="min-h-0 flex-1 overflow-hidden">
      <!-- La lista entera desplaza dentro de la columna, y el título de cada día
           se queda pegado arriba mientras pasan sus eventos: es lo que dice de
           qué día es lo que se está leyendo cuando el día tiene muchos.

           El título pegado es opaco (no hay desenfoque): el fondo de la ventana
           con la superficie al 70 % encima. Lo que pasa por debajo tiene que ser
           de ese mismo color, y la ventana es translúcida (`bg-ui-bg/80`): sobre
           ella, o sobre un `Panel` apoyado en ella, cada título se veía como una
           franja de otro tono, más en oscuro. Por eso el panel se apoya en una
           base opaca del fondo de la ventana, con el mismo radio para que no
           asome por las esquinas: panel y título dan exactamente el mismo color,
           con cualquier cosa detrás de la ventana.

           Lo que desplaza es un envoltorio y no el `Panel`: con las plantillas
           estrictas, un atributo que el panel no declara no compila. -->
      <div
        ref="scroller"
        class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        data-testid="month-agenda">
        <EmptyState
          v-if="empty"
          icon="x-office-calendar"
          :title="t('agenda.empty')"
          :note="t('agenda.emptyNote')" />
        <template v-else>
          <section
            v-for="section in sections"
            :key="section.day.clave"
            class="flex min-w-0 flex-col px-2 pb-2"
            :data-day="section.day.clave"
            :aria-current="section.day.esHoy ? 'date' : undefined">
            <SectionHeading
              sticky
              surface="panel"
              as="h2"
              class="px-1"
              :title="headingOf(section.day)" />
            <ListGroup>
              <ListRow
                v-if="section.events.length === 0"
                :title="t('agenda.nothing')" />
              <ListRow
                v-for="event in section.events"
                :key="`${event.uid}-${event.start}`"
                :title="titleOf(event)"
                :description="timeOf(event, section.day.clave)">
                <!-- El color del calendario es **dato** del servidor, no un color
                     del esquema: va por la propiedad del punto, que lo pone en una
                     variable y le da el canto que lo hace visible sobre cualquier
                     fondo. Sin color, el acento, como en la cuadrícula. -->
                <template #leading>
                  <StatusDot size="md" tone="accent" :color="event.color ?? undefined" />
                </template>
                <template v-if="foreignZoneOf(event) || event.recurring" #trailing>
                  <span
                    v-if="foreignZoneOf(event)"
                    class="flex text-tx-muted"
                    role="img"
                    :title="interpolar(t('calendario.escritoEn'), foreignZoneOf(event))"
                    :aria-label="interpolar(t('calendario.escritoEn'), foreignZoneOf(event))"
                    data-testid="foreign-zone-mark">
                    <ThemeIcon name="preferences-system-time" type="symbol" :size="16" alt="" />
                  </span>
                  <span
                    v-if="event.recurring"
                    class="flex text-tx-muted"
                    role="img"
                    :title="recurrenceNoteOf(event)"
                    :aria-label="recurrenceNoteOf(event)"
                    data-testid="recurrence-mark">
                    <ThemeIcon name="media-playlist-repeat" type="symbol" :size="16" alt="" />
                  </span>
                </template>
              </ListRow>
            </ListGroup>
          </section>
        </template>
      </div>
    </Panel>
  </div>
</template>
