<script lang="ts" setup>
/**
 * La cabecera de una columna de día: el nombre corto del día y su número, con el
 * velo de acento cuando es hoy. La comparten la vista de columnas (lista) y la
 * grilla horaria, que la dibujaban igual; vive una sola vez acá.
 *
 * Las dos etiquetas van `aria-hidden`: el nombre accesible de la columna lo pone
 * el contenedor (`aria-label` con el día completo), así el lector no repite.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { computed } from 'vue';

const props = defineProps<{
	/** El día, para formatear su nombre y número. */
	fecha: Date;
	/** Si es hoy, para el velo de acento. */
	isToday: boolean;
	/** La zona en la que se mira la agenda: decide qué día nombra cada fecha. */
	zone: string;
}>();

const { locale } = useI18n();

const weekdayFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { weekday: 'short', timeZone: props.zone })
);
const dayNumberFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', timeZone: props.zone })
);
</script>

<template>
  <span
    class="truncate text-label-xs text-tx-muted uppercase tracking-wide"
    aria-hidden="true">
    {{ weekdayFormat.format(fecha) }}
  </span>
  <span
    class="flex h-6 min-w-6 items-center justify-center rounded-corner-full px-1 text-sm tabular-nums"
    :class="isToday ? 'bg-ui-selected-accent font-semibold text-tx-main' : 'text-tx-main'"
    aria-hidden="true">
    {{ dayNumberFormat.format(fecha) }}
  </span>
</template>
