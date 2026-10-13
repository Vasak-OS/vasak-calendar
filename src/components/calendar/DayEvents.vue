<script lang="ts" setup>
/**
 * Los eventos de **un** día, como lista, con la hora entera y en la zona de la
 * agenda.
 *
 * Es la pieza común de las vistas que muestran horas —día, N días, semana y la
 * agenda—: así todas dicen la hora igual, y la hora la calcula `eventSpanOn`
 * (`tools/agenda.ts`), que ya resuelve lo que se equivoca en silencio —qué hora
 * decir de algo que no empieza ni termina ese día, una guardia de las 22 a las
 * 6—. No se usa el `EventList` de la librería acá porque no mira `timeZone`: con
 * una zona ajena elegida diría las horas con el reloj del sistema, que es justo
 * lo que esta aplicación existe para no hacer.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { EmptyState, ListGroup, ListRow, StatusDot, ThemeIcon } from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import { eventSpanOn } from '@/tools/agenda';
import { interpolar } from '@/tools/interpolar';
import type { CalendarEvent } from '@/tools/mes';

const props = defineProps<{
	events: CalendarEvent[];
	/** El día que se está mostrando, `AAAA-MM-DD`: lo que decide qué hora decir. */
	dayKey: string;
	/** En qué zona se está mirando la agenda. Todo lo que dice una hora la usa. */
	zone: string;
}>();

const { t, locale } = useI18n();

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

/** En qué zona lo escribieron, si no es la misma en la que se está mirando. */
function foreignZoneOf(event: CalendarEvent): string {
	return event.zone && event.zone !== props.zone ? event.zone : '';
}

function recurrenceNoteOf(event: CalendarEvent): string {
	return event.shown_once
		? `${t('calendario.recurring')} — ${t('calendario.shownOnce')}`
		: t('calendario.recurring');
}
</script>

<template>
  <EmptyState
    v-if="events.length === 0"
    icon="x-office-calendar"
    size="sm"
    :title="t('calendario.sinEventos')" />
  <ListGroup v-else>
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
      <template v-if="foreignZoneOf(event) || event.recurring" #trailing>
        <span
          v-if="foreignZoneOf(event)"
          class="flex text-tx-muted"
          role="img"
          :title="interpolar(t('calendario.escritoEn'), foreignZoneOf(event))"
          :aria-label="interpolar(t('calendario.escritoEn'), foreignZoneOf(event))"
          data-testid="foreign-zone-mark">
          <ThemeIcon name="preferences-system-time" type="symbol" :size="16" alt="" />
        </span>
        <span
          v-if="event.recurring"
          class="flex text-tx-muted"
          role="img"
          :title="recurrenceNoteOf(event)"
          :aria-label="recurrenceNoteOf(event)"
          data-testid="recurrence-mark">
          <ThemeIcon name="media-playlist-repeat" type="symbol" :size="16" alt="" />
        </span>
      </template>
    </ListRow>
  </ListGroup>
</template>
