<script lang="ts" setup>
/**
 * Los días uno al lado del otro: la vista de día (una columna), de N días y de
 * semana (siete). Es la misma pieza para las tres —cambia cuántos días recibe—,
 * así que no se separan.
 *
 * ── Responsive sin puntos de corte de pantalla ──────────────────────────────
 *
 * Las columnas se reparten con `repeat(auto-fit, minmax(…, 1fr))`: la propia
 * grilla pone las que entren y, cuando no entran, baja las de más a la fila
 * siguiente; por debajo de una columna de ancho queda **una sola**, a ventana
 * completa. Así nada se corta ni se pisa a 240 o 360 px y no hace falta ningún
 * `@media` ni `sm:`/`md:`, que un componente no puede usar porque no sabe en qué
 * ventana vive. Va por `style` y no por una clase con corchetes para no depender
 * de que Tailwind sepa generar un valor con comas anidadas.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { Panel } from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import DayColumnHeader from '@/components/calendar/DayColumnHeader.vue';
import DayEvents from '@/components/calendar/DayEvents.vue';
import type { CalendarEvent } from '@/tools/mes';
import type { DayRangeProps } from '@/tools/views';

const props = defineProps<DayRangeProps>();
const emit = defineEmits<{ open: [event: CalendarEvent] }>();

const { locale } = useI18n();

// El formato lleva `timeZone`: el día completo del nombre accesible sale en la
// zona de la agenda y no en la del sistema, que es la que contestaría `Date`. El
// nombre y el número del día los pone `DayColumnHeader`.
const fullDayFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeZone: props.zone })
);

/** Un mínimo por columna para que un día no quede más angosto que su contenido. */
const columns = { gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' };
</script>

<template>
  <Panel padding="none" class="min-h-0 flex-1 overflow-hidden">
    <div class="h-full min-h-0 overflow-y-auto" data-testid="columns-view">
      <div class="grid" :style="columns">
        <section
          v-for="day in days"
          :key="day.clave"
          class="flex min-w-0 flex-col gap-1 border-ui-line-weak border-r border-b p-2 last:border-r-0"
          :data-day="day.clave"
          :aria-current="day.esHoy ? 'date' : undefined"
          :aria-label="fullDayFormat.format(day.fecha)">
          <div class="flex items-center gap-1">
            <DayColumnHeader :fecha="day.fecha" :is-today="day.esHoy" :zone="zone" />
          </div>
          <DayEvents
            :events="eventsOf(day.clave)"
            :day-key="day.clave"
            :zone="zone"
            @open="emit('open', $event)" />
        </section>
      </div>
    </div>
  </Panel>
</template>
