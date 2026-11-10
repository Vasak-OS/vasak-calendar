<script lang="ts" setup>
/**
 * El título de un evento con sus marcas al costado: la pieza común del bloque de
 * todo el día y del bloque con hora de la grilla, que la dibujaban igual. Es
 * sólo presentación —no decide nada— y deja los dos lugares con una línea.
 *
 * Son varios nodos raíz a propósito: el que lo usa los acomoda (en fila suelta
 * o dentro de su propio contenedor), así que este componente no impone caja.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import EventMarks from '@/components/calendar/EventMarks.vue';
import SyncBadge from '@/components/calendar/SyncBadge.vue';
import type { CalendarEvent } from '@/tools/mes';

const props = defineProps<{
	event: CalendarEvent;
	/** La zona en la que se mira la agenda, para saber si el evento está en otra. */
	zone: string;
	/** El título en negrita (el bloque con hora) o normal (la franja de todo el día). */
	bold?: boolean;
}>();

const { t } = useI18n();

function titleOf(): string {
	return props.event.title.trim() || t('calendario.sinTitulo');
}

/** Si el evento lleva marcas: que se repite, o que está escrito en otra zona. */
function hasMarks(): boolean {
	return props.event.recurring || (!!props.event.zone && props.event.zone !== props.zone);
}
</script>

<template>
  <span class="truncate" :class="{ 'font-semibold': bold }" aria-hidden="true">{{ titleOf() }}</span>
  <EventMarks v-if="hasMarks()" :event="event" :zone="zone" :size="12" />
  <SyncBadge :event="event" compact />
</template>
