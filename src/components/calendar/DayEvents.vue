<script lang="ts" setup>
/**
 * Los eventos de **un** día, como lista, con la hora entera y en la zona de la
 * agenda.
 *
 * Es la pieza común de todo lo que muestra los eventos de un día —la agenda del
 * mes, la agenda como vista, y las columnas de día, N días y semana—: así todas
 * dicen la hora igual, con `eventSpanOn` (`tools/agenda.ts`), que ya resuelve lo
 * que se equivoca en silencio (qué hora decir de algo que no empieza ni termina
 * ese día, una guardia de las 22 a las 6). No se usa el `EventList` de la
 * librería acá porque no mira `timeZone`: con una zona ajena elegida diría las
 * horas con el reloj del sistema, que es justo lo que esta app existe para no
 * hacer.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ListGroup, ListRow, StatusDot } from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import EventMarks from '@/components/calendar/EventMarks.vue';
import { eventSpanOn } from '@/tools/agenda';
import { interpolar } from '@/tools/interpolar';
import type { CalendarEvent } from '@/tools/mes';

const props = withDefaults(
	defineProps<{
		events: CalendarEvent[];
		/** El día que se muestra, `AAAA-MM-DD`: lo que decide qué hora decir. */
		dayKey: string;
		/** En qué zona se está mirando la agenda. Todo lo que dice una hora la usa. */
		zone: string;
		/** Qué decir cuando el día no tiene nada. */
		emptyLabel?: string;
	}>(),
	{ emptyLabel: undefined }
);

const { t, locale } = useI18n();

const emptyText = computed(() => props.emptyLabel ?? t('calendario.sinEventos'));

const timeFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			hour: '2-digit',
			minute: '2-digit',
			timeZone: props.zone,
		})
);

function titleOf(event: CalendarEvent): string {
	return event.title.trim() || t('calendario.sinTitulo');
}

/** La hora de un evento ese día, enteramente, según qué parte cae ahí. */
function timeOf(event: CalendarEvent): string {
	const span = eventSpanOn(event, props.dayKey, props.zone);
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

function hasMarks(event: CalendarEvent): boolean {
	return event.recurring || (!!event.zone && event.zone !== props.zone);
}
</script>

<template>
  <ListGroup>
    <ListRow v-if="events.length === 0" :title="emptyText" />
    <ListRow
      v-for="event in events"
      :key="`${event.uid}-${event.start}`"
      :title="titleOf(event)"
      :description="timeOf(event)">
      <!-- El color del calendario es **dato** del servidor, no un color del
           esquema: va por la propiedad del punto, que lo pone en una variable y
           le da el canto que lo hace visible sobre cualquier fondo. Sin color,
           el acento. -->
      <template #leading>
        <StatusDot size="md" tone="accent" :color="event.color ?? undefined" />
      </template>
      <template v-if="hasMarks(event)" #trailing>
        <EventMarks :event="event" :zone="zone" :size="16" />
      </template>
    </ListRow>
  </ListGroup>
</template>
