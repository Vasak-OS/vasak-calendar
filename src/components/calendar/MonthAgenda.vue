<script lang="ts" setup>
/**
 * El mes —o cualquier rango de días— como agenda: una lista de los días que
 * tienen algo, con la ventana angosta y como vista propia de agenda.
 *
 * Por debajo de 36 rem de fila la cuadrícula queda con siete columnas de unos
 * 30 px y los eventos se ven como una hora cortada; ahí el mes pasa a ser esta
 * lista, como en un teléfono. Y es también la vista de «agenda», que se elige a
 * mano con cualquier ancho.
 *
 * Reparte los eventos con `agendaSections` (`tools/agenda.ts`) y dibuja cada día
 * con `DayEvents`, la misma pieza que las columnas de día: así la hora se dice
 * igual en todas las vistas y en una sola parte.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { EmptyState, Panel, SectionHeading } from '@vasakgroup/vue-libvasak';
import { computed, ref } from 'vue';
import DayEvents from '@/components/calendar/DayEvents.vue';
import { agendaSections, isAgendaEmpty, todaySectionKey } from '@/tools/agenda';
import { interpolar } from '@/tools/interpolar';
import type { CalendarEvent, Dia } from '@/tools/mes';
import type { DayRangeProps } from '@/tools/views';

const props = defineProps<DayRangeProps>();
const emit = defineEmits<{ open: [event: CalendarEvent] }>();

const { t, locale } = useI18n();

const sections = computed(() => agendaSections(props.days, props.eventsOf));
const empty = computed(() => isAgendaEmpty(sections.value));

/** «jueves, 1 de octubre»: sin el año, que ya está en el título del período. */
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

const scroller = ref<HTMLElement | null>(null);

/**
 * Lleva la lista al día de hoy, con su título arriba de todo.
 *
 * Con `scrollTo` sobre la lista y no con `scrollIntoView` sobre el día: el
 * segundo desplaza también a los antepasados que puedan desplazarse, y con la
 * ventana entera moviéndose la barra se iría para arriba.
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
           se queda pegado arriba mientras pasan sus eventos. El título pegado es
           opaco (no hay desenfoque): por eso el panel se apoya en una base opaca
           del fondo de la ventana, con el mismo radio, para que panel y título
           den exactamente el mismo color con cualquier cosa detrás. -->
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
            <DayEvents
              :events="section.events"
              :day-key="section.day.clave"
              :zone="zone"
              :empty-label="t('agenda.nothing')"
              @open="emit('open', $event)" />
          </section>
        </template>
      </div>
    </Panel>
  </div>
</template>
