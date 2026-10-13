<script lang="ts" setup>
/**
 * El selector de vista: día, N días, semana, mes, año y agenda.
 *
 * Es el `SegmentedControl` de la librería, que es la forma de Once UI para
 * elegir entre pocas opciones excluyentes. Con la ventana angosta no entran las
 * seis de una, así que su envoltorio deja desplazar de costado en vez de
 * aplastarlas: nada se corta, se llega a todas. La aplicación decide qué hacer
 * con la elección; esto sólo la ofrece y avisa.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { SegmentedControl, type SegmentedOption } from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import { interpolar } from '@/tools/interpolar';
import { CALENDAR_VIEWS, type CalendarView, DAYS_VIEW_COUNT } from '@/tools/views';

const props = defineProps<{ modelValue: CalendarView }>();
const emit = defineEmits<{ change: [CalendarView] }>();

const { t } = useI18n();

const options = computed<SegmentedOption<CalendarView>[]>(() =>
	CALENDAR_VIEWS.map((view) => ({
		value: view,
		// «N días» dice el número de verdad; el resto es una etiqueta suelta.
		label: view === 'days' ? interpolar(t('view.days'), DAYS_VIEW_COUNT) : t(`view.${view}`),
	}))
);
</script>

<template>
  <div class="min-w-0 overflow-x-auto">
    <SegmentedControl
      :model-value="props.modelValue"
      :options="options"
      :label="t('view.label')"
      @change="(value: CalendarView) => emit('change', value)" />
  </div>
</template>
