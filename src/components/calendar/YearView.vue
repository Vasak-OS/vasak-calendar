<script lang="ts" setup>
/**
 * El año de un vistazo: doce meses chiquitos, con un punto en los días que
 * tienen algo. Tocar un día abre ese día; tocar el nombre del mes abre el mes.
 *
 * Los meses se reparten con `repeat(auto-fit, minmax(…, 1fr))`, como las
 * columnas de la vista de días: la grilla pone los que entren y baja el resto,
 * hasta uno por fila en una ventana angosta. Sin `@media` ni `sm:`/`md:`, que
 * un componente no puede usar.
 *
 * Cada mes reusa `cuadricula` (`tools/mes.ts`), la misma que la vista de mes, y
 * el punto sale de `eventsOf`, los eventos del año ya repartidos por día: así el
 * año y el mes marcan los mismos días. El punto es el acento del **esquema**, no
 * el color del calendario: a este tamaño no cabe distinguir de cuál es, sólo si
 * hay algo.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { Panel } from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import { interpolar } from '@/tools/interpolar';
import { type CalendarEvent, cuadricula, type Dia } from '@/tools/mes';
import { medianocheDe } from '@/tools/zona';

const props = defineProps<{
	year: number;
	/** En qué zona se está mirando la agenda. */
	zone: string;
	/** Hoy, para el día marcado. Sin esto, el de la máquina; se pasa en una prueba. */
	today?: Date;
	eventsOf: (clave: string) => CalendarEvent[];
}>();

const emit = defineEmits<{
	selectDay: [Date];
	selectMonth: [Date];
}>();

const { t, locale } = useI18n();

const monthNameFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { month: 'long', timeZone: props.zone })
);
const dayNumberFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', timeZone: props.zone })
);
const fullDayFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeZone: props.zone })
);

/** Las iniciales de los días, con el lunes primero como la cuadrícula del mes. */
const weekdayInitials = computed(() => {
	const narrow = new Intl.DateTimeFormat(locale.value, { weekday: 'narrow' });
	// Un lunes cualquiera de origen: el 5 de enero de 2026 lo es.
	return Array.from({ length: 7 }, (_, i) => narrow.format(new Date(2026, 0, 5 + i)));
});

/** Los doce meses, cada uno con su cuadrícula de días. */
const months = computed(() => {
	const when = props.today ?? new Date();
	return Array.from({ length: 12 }, (_, index) => {
		const first = medianocheDe(
			{ anio: props.year, mes: index + 1, dia: 1, hora: 0, minuto: 0 },
			props.zone
		);
		return { index, first, days: cuadricula(first, props.zone, when) };
	});
});

function hasEvents(day: Dia): boolean {
	return props.eventsOf(day.clave).length > 0;
}

function dayLabel(day: Dia): string {
	const date = fullDayFormat.value.format(day.fecha);
	return hasEvents(day) ? interpolar(t('calendario.conEventos'), date) : date;
}
</script>

<template>
  <Panel padding="none" class="min-h-0 flex-1 overflow-hidden">
    <div class="h-full min-h-0 overflow-y-auto p-2" data-testid="year-view">
      <div
        class="grid gap-3"
        :style="{ gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))' }">
        <section
          v-for="month in months"
          :key="month.index"
          class="flex min-w-0 flex-col gap-1"
          :data-month="month.index + 1">
          <button
            type="button"
            class="truncate text-left font-title text-label-m first-letter:uppercase hover:text-primary"
            @click="emit('selectMonth', month.first)">
            {{ monthNameFormat.format(month.first) }}
          </button>
          <div class="grid grid-cols-7 gap-0.5">
            <span
              v-for="(initial, i) in weekdayInitials"
              :key="`wd-${i}`"
              class="text-center text-label-xs text-tx-muted"
              aria-hidden="true">
              {{ initial }}
            </span>
            <button
              v-for="day in month.days"
              :key="day.clave"
              type="button"
              class="flex aspect-square min-w-0 items-center justify-center rounded-corner-xs text-xs tabular-nums hover:bg-ui-hover"
              :class="[
                day.delMes ? 'text-tx-main' : 'text-tx-muted/40',
                day.esHoy ? 'bg-ui-selected-accent font-semibold' : '',
              ]"
              :aria-label="dayLabel(day)"
              :aria-current="day.esHoy ? 'date' : undefined"
              @click="emit('selectDay', day.fecha)">
              <span class="relative flex items-center justify-center">
                {{ dayNumberFormat.format(day.fecha) }}
                <!-- Un punto para decir que ese día tiene algo. El acento del
                     esquema y no el color del calendario: a este tamaño no cabe
                     de cuál es, sólo si lo hay. -->
                <span
                  v-if="hasEvents(day)"
                  class="-bottom-1 absolute h-1 w-1 rounded-corner-full bg-primary"
                  aria-hidden="true"
                  data-testid="year-event-dot"></span>
              </span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </Panel>
</template>
