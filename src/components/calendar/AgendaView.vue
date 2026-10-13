<script lang="ts" setup>
/**
 * La agenda como vista propia: el período entero en una lista, siempre, con
 * cualquier ancho.
 *
 * Se parece al mes en ventana angosta (`MonthAgenda`), pero es su propia vista
 * —se elige a mano y no depende del ancho— y por eso vive aparte. Reparte los
 * eventos con `agendaSections` (`tools/agenda.ts`), la misma que la otra, así
 * que las dos dicen lo mismo del mismo mes; y cada día lo dibuja `DayEvents`,
 * que calcula las horas en la zona de la agenda.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { EmptyState, Panel, SectionHeading } from '@vasakgroup/vue-libvasak';
import { computed, ref } from 'vue';
import DayEvents from '@/components/calendar/DayEvents.vue';
import { agendaSections, isAgendaEmpty, todaySectionKey } from '@/tools/agenda';
import { interpolar } from '@/tools/interpolar';
import type { CalendarEvent, Dia } from '@/tools/mes';

const props = defineProps<{
	days: Dia[];
	/** En qué zona se está mirando la agenda. Todo lo que dice una hora la usa. */
	zone: string;
	eventsOf: (clave: string) => CalendarEvent[];
}>();

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

/** Lleva la lista al día de hoy, con su título arriba de todo (como `MonthAgenda`). */
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
      <div
        ref="scroller"
        class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        data-testid="agenda-view">
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
            <DayEvents :events="section.events" :day-key="section.day.clave" :zone="zone" />
          </section>
        </template>
      </div>
    </Panel>
  </div>
</template>
