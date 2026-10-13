<script lang="ts" setup>
/**
 * Las marcas de un evento: que está escrito en otra zona, y que se repite.
 *
 * Son iconos del tema —no caracteres— y viven en un solo lugar porque las
 * muestran la cuadrícula del mes, la agenda y las columnas de día; antes había
 * una copia en cada una, y tres copias terminan diciendo cosas distintas. El
 * tamaño lo pone quien las usa: 12 en la celda apretada del mes, 16 en una fila.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ThemeIcon } from '@vasakgroup/vue-libvasak';
import { interpolar } from '@/tools/interpolar';
import type { CalendarEvent } from '@/tools/mes';

const props = withDefaults(
	defineProps<{
		event: CalendarEvent;
		/** En qué zona se está mirando: decide si la marca de zona hace falta. */
		zone: string;
		size?: number;
	}>(),
	{ size: 16 }
);

const { t } = useI18n();

/** En qué zona lo escribieron, si no es la misma en la que se está mirando. */
function foreignZoneOf(event: CalendarEvent): string {
	return event.zone && event.zone !== props.zone ? event.zone : '';
}

/** «Se repite», o además que se muestra sólo el día que empieza. */
function recurrenceNoteOf(event: CalendarEvent): string {
	return event.shown_once
		? `${t('calendario.recurring')} — ${t('calendario.shownOnce')}`
		: t('calendario.recurring');
}
</script>

<template>
  <!-- Las dos marcas son iconos del tema y no caracteres: 🌐 y ↻ salían de la
       fuente que hubiera, con su propio color y tamaño. -->
  <span
    v-if="foreignZoneOf(event)"
    class="flex shrink-0 text-tx-muted"
    role="img"
    :title="interpolar(t('calendario.escritoEn'), foreignZoneOf(event))"
    :aria-label="interpolar(t('calendario.escritoEn'), foreignZoneOf(event))"
    data-testid="foreign-zone-mark">
    <ThemeIcon name="preferences-system-time" type="symbol" :size="size" alt="" />
  </span>
  <!-- Una serie que no se pudo expandir se muestra sólo el día que empieza, y
       eso se dice: sin la marca, una reunión semanal parece única. -->
  <span
    v-if="event.recurring"
    class="flex shrink-0 text-tx-muted"
    role="img"
    :title="recurrenceNoteOf(event)"
    :aria-label="recurrenceNoteOf(event)"
    data-testid="recurrence-mark">
    <ThemeIcon name="media-playlist-repeat" type="symbol" :size="size" alt="" />
  </span>
</template>
