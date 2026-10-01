<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { Panel, ThemeIcon } from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import { claveSegunCantidad, interpolar } from '@/tools/interpolar';
import type { CalendarEvent, Dia } from '@/tools/mes';

const props = defineProps<{
	days: Dia[];
	/** En qué zona se está mirando la agenda. Todo lo que dice una hora la usa. */
	zone: string;
	eventsOf: (clave: string) => CalendarEvent[];
}>();

const { t, locale } = useI18n();

/**
 * Cuántos eventos entran en una celda antes de resumir.
 *
 * Tres y no «los que quepan»: una celda que crece con su contenido hace que la
 * fila entera crezca, y un día con doce reuniones aplastaría a los otros seis de
 * su semana hasta dejarlos ilegibles. Lo que no entra se cuenta.
 */
const VISIBLE_EVENTS = 3;

/**
 * Los nombres de los días y de los meses salen de `Intl`, no del catálogo.
 *
 * Traducirlos a mano sería mantener doce meses y siete días por idioma para algo
 * que el sistema ya sabe hacer —y hacerlo mejor: sabe de mayúsculas, de
 * abreviaturas y de idiomas que no escribimos nosotros. El catálogo se queda con
 * lo que es de esta aplicación.
 */
const weekdayNames = computed(() => {
	const short = new Intl.DateTimeFormat(locale.value, { weekday: 'short' });
	const long = new Intl.DateTimeFormat(locale.value, { weekday: 'long' });
	// Un lunes cualquiera como origen: el 5 de enero de 2026 lo es.
	return Array.from({ length: 7 }, (_, i) => {
		const day = new Date(2026, 0, 5 + i);
		return { short: short.format(day), long: long.format(day) };
	});
});

// Los tres formatos llevan `timeZone`: sin eso el número del día y la hora del
// evento salen en la zona del sistema aunque la agenda se esté mirando en otra,
// y la cuadrícula diría una cosa y las horas otra.
const timeFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			hour: '2-digit',
			minute: '2-digit',
			timeZone: props.zone,
		})
);

const dayFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeZone: props.zone })
);

const dayNumberFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', timeZone: props.zone })
);

/** Las seis filas de siete días. */
const weeks = computed(() => {
	const rows: Dia[][] = [];
	for (let i = 0; i < props.days.length; i += 7) {
		rows.push(props.days.slice(i, i + 7));
	}
	return rows;
});

function visibleOf(day: Dia): CalendarEvent[] {
	return props.eventsOf(day.clave).slice(0, VISIBLE_EVENTS);
}

function overflowOf(day: Dia): number {
	return Math.max(0, props.eventsOf(day.clave).length - VISIBLE_EVENTS);
}

function titleOf(event: CalendarEvent): string {
	return event.title.trim() || t('calendario.sinTitulo');
}

/** La hora de un evento, o «todo el día» si no tiene. */
function timeOf(event: CalendarEvent): string {
	if (event.all_day) {
		return t('calendario.todoElDia');
	}
	return timeFormat.value.format(new Date(event.start));
}

/**
 * Lo que lee un lector de pantalla al pararse en un evento.
 *
 * La hora y el título juntos: el color dice de qué calendario es, y un color no
 * se lee.
 */
function descriptionOf(event: CalendarEvent): string {
	const base = interpolar(t('calendario.eventosDelDia'), timeOf(event), titleOf(event));
	const other = foreignZoneOf(event);
	return other ? `${base} — ${interpolar(t('calendario.escritoEn'), other)}` : base;
}

/**
 * En qué zona lo escribieron, si no es la misma en la que se está mirando.
 *
 * Vacío cuando coinciden, que es el caso normal y no hace falta decir. Cuando no
 * coinciden importa: la hora que se muestra es correcta, pero quien escribió
 * «10:00» en Madrid espera leer 10:00, y va a leer otra cosa. Decir en qué zona
 * está escrito es la diferencia entre que eso se entienda y que parezca un error
 * del calendario.
 */
function foreignZoneOf(event: CalendarEvent): string {
	return event.zone && event.zone !== props.zone ? event.zone : '';
}

/**
 * Lo que dice la marca de repetición: «se repite», o, si la serie no se pudo
 * expandir, además que se muestra sólo el día que empieza.
 */
function recurrenceNoteOf(event: CalendarEvent): string {
	return event.shown_once
		? `${t('calendario.recurring')} — ${t('calendario.shownOnce')}`
		: t('calendario.recurring');
}

function overflowSummary(count: number): string {
	return interpolar(t(claveSegunCantidad('calendario.masEventos', count)), count);
}
</script>

<template>
  <Panel padding="none" class="min-h-0 flex-1 overflow-hidden">
    <!-- Una cuadrícula de verdad y no un montón de divs: con `grid`, `row` y
         `gridcell`, un lector de pantalla dice «martes 15 de septiembre, columna
         2» en vez de leer 42 cosas sueltas sin relación entre sí.

         Lo que **todavía no** hace es moverse con las flechas: eso pide un
         `tabindex` móvil y sus manejadores de teclado, y no está escrito. Se
         recorre con Tab como cualquier otra cosa.

         La superficie es el `Panel` de la librería, la misma de la columna de
         cuentas. `overflow-hidden` con las esquinas redondeadas: las celdas del
         borde tienen sus propias líneas, y sin recortar se asoman por fuera de
         la curva y la esquina se ve mordida. Los comentarios van adentro de la
         raíz: arriba la volverían un fragmento.

         El rol va en un envoltorio y no en el `Panel`: el panel no declara
         `role` como propiedad, y con las plantillas estrictas un atributo que
         el componente no declara no compila. -->
    <div class="flex min-h-0 flex-1 flex-col" role="grid" :aria-label="t('app.nombre')">
      <div class="grid grid-cols-7 border-ui-line-weak border-b" role="row">
        <!-- Abreviado a la vista y entero para quien escucha: «lun» leído en voz
             alta no es una palabra. Recortado si no entra: en una ventana angosta
             la columna mide menos que la abreviatura. -->
        <div
          v-for="weekday in weekdayNames"
          :key="weekday.long"
          class="min-w-0 truncate px-2 py-1 text-center font-semibold text-label-xs text-tx-muted uppercase tracking-wider"
          role="columnheader"
          :aria-label="weekday.long">
          <span aria-hidden="true">{{ weekday.short }}</span>
        </div>
      </div>

      <!-- `rowgroup` y no un div pelado: una `grid` tiene que ser dueña de sus
           filas, y un elemento sin rol en el medio las desprende del árbol de
           accesibilidad. Las filas quedaban ahí pero la cuadrícula no las
           reconocía como suyas. -->
      <!-- Las filas que tenga el mes, no seis fijas: septiembre de 2026 dibujaba
           una séptima entera del mes siguiente. `1fr` cada una con `minmax(0,…)`,
           que es lo que deja que la celda recorte su contenido en vez de estirar
           la fila hasta desbordar la ventana. -->
      <div
        class="grid min-h-0 flex-1"
        :style="{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }"
        role="rowgroup">
        <div
          v-for="(week, index) in weeks"
          :key="index"
          class="grid grid-cols-7"
          role="row">
          <div
            v-for="day in week"
            :key="day.clave"
            class="flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-ui-line-weak border-r p-1 last:border-r-0"
            :class="{
              // La línea de abajo la lleva cada fila menos la última: ahí el
              // borde ya lo pone la superficie que contiene la cuadrícula, y las
              // dos juntas se ven como una raya doble pegada a la esquina.
              'border-b': index < weeks.length - 1,
              // Los días del mes anterior y del siguiente se ven, porque son días
              // reales con eventos reales, pero apagados: si pesaran igual, no se
              // distinguiría dónde empieza el mes que se está mirando.
              'bg-ui-surface/20': !day.delMes,
            }"
            role="gridcell"
            :aria-label="dayFormat.format(day.fecha)">
            <div class="flex items-center justify-between">
              <!-- Hoy, con el velo de acento de lo elegido (decisión 4 de
                   vasak-desktop#144) y no con el relleno del primario: el
                   primario de fábrica con su texto encima no llegaba al
                   contraste, y es la misma marca que usa el resto del sistema
                   para «éste». -->
              <span
                class="flex h-6 min-w-6 items-center justify-center rounded-corner-full px-1 text-sm tabular-nums"
                :class="[
                  day.esHoy ? 'bg-ui-selected-accent font-semibold' : '',
                  day.delMes ? 'text-tx-main' : 'text-tx-muted',
                ]"
                :aria-current="day.esHoy ? 'date' : undefined">
                {{ dayNumberFormat.format(day.fecha) }}
              </span>
            </div>

            <ul class="flex min-h-0 flex-col gap-0.5 overflow-hidden">
              <li
                v-for="event in visibleOf(day)"
                :key="`${event.uid}-${event.start}`"
                class="flex min-w-0 items-center gap-1 truncate rounded-corner-xs bg-ui-surface/60 px-1 py-0.5 text-xs"
                :title="descriptionOf(event)">
                <!-- El color del calendario, como una marca al costado y no como
                     fondo del evento: de fondo, un color cualquiera del servidor
                     puede dejar el texto ilegible, y no hay forma de saber de
                     antemano si es claro u oscuro.

                     Es **dato**, no un color del esquema: va por `style`, que es
                     la excepción nombrada en `tests/design-guard.test.ts`. Sin
                     color, el acento. -->
                <span
                  class="h-3 w-1 shrink-0 rounded-corner-full"
                  :style="{ backgroundColor: event.color ?? 'var(--color-primary)' }"
                  aria-hidden="true"
                  data-testid="event-color"></span>
                <span class="sr-only">{{ descriptionOf(event) }}</span>
                <span class="shrink-0 text-tx-muted tabular-nums" aria-hidden="true">
                  {{ event.all_day ? '' : timeOf(event) }}
                </span>
                <span class="truncate" aria-hidden="true">{{ titleOf(event) }}</span>
                <!-- Las dos marcas son iconos del tema y no caracteres: 🌐 y ↻
                     salían de la fuente que hubiera, con su propio color y
                     tamaño, y el globo en color en medio de una fila de texto. -->
                <span
                  v-if="foreignZoneOf(event)"
                  class="flex shrink-0 text-tx-muted"
                  :title="interpolar(t('calendario.escritoEn'), foreignZoneOf(event))"
                  aria-hidden="true"
                  data-testid="foreign-zone-mark">
                  <ThemeIcon name="preferences-system-time" type="symbol" :size="12" alt="" />
                </span>
                <!-- Una serie que no se pudo expandir se muestra sólo el día que
                     empieza, y eso se dice: sin la marca, una reunión semanal
                     parece única y las demás semanas parecen libres. Las que sí
                     se expandieron llevan la marca común de «se repite». -->
                <span
                  v-if="event.recurring"
                  class="flex shrink-0 text-tx-muted"
                  role="img"
                  :title="recurrenceNoteOf(event)"
                  :aria-label="recurrenceNoteOf(event)"
                  data-testid="recurrence-mark">
                  <ThemeIcon name="media-playlist-repeat" type="symbol" :size="12" alt="" />
                </span>
              </li>
              <li v-if="overflowOf(day) > 0" class="break-words px-1 text-tx-muted text-xs">
                {{ overflowSummary(overflowOf(day)) }}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </Panel>
</template>
