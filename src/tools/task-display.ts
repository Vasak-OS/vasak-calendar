/**
 * Cómo se muestra una tarea en la lista: el texto del vencimiento y si ya pasó.
 *
 * Va aparte y sin nada de Vue porque es lo mismo que en `mes.ts` —una fecha leída
 * en la zona equivocada cae un día de lugar y no se nota—, y acá se prueba sin
 * montar nada. El vencimiento llega en ISO 8601 (UTC) desde el almacén; se lee en
 * la zona de la agenda, salvo el de todo-el-día, que se lee en UTC (el almacén lo
 * guarda como la medianoche UTC de ese día, y leerlo en otra zona lo correría,
 * igual que en `ical-date.ts`).
 */

/**
 * El vencimiento en una forma corta para la lista, en el idioma y la zona de la
 * agenda. Un día entero sale sólo con la fecha; con hora, fecha y hora. Vacío si
 * la tarea no tiene vencimiento o la fecha no se entiende.
 */
export function formatDue(
	due: string | null | undefined,
	allDay: boolean,
	zone: string,
	locale: string
): string {
	if (!due) {
		return '';
	}
	const date = new Date(due);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	const options: Intl.DateTimeFormatOptions = allDay
		? { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }
		: {
				timeZone: zone,
				day: 'numeric',
				month: 'short',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			};
	return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * Si el vencimiento ya pasó, comparado con `now`. Una tarea terminada nunca está
 * vencida: ya se hizo. El de todo-el-día vence al **terminar** el día (su
 * medianoche UTC siguiente), no al empezar, para no marcar en rojo algo que
 * todavía se puede hacer hoy.
 */
export function isOverdue(
	due: string | null | undefined,
	allDay: boolean,
	done: boolean,
	now: Date = new Date()
): boolean {
	if (done || !due) {
		return false;
	}
	const date = new Date(due);
	if (Number.isNaN(date.getTime())) {
		return false;
	}
	const limit = allDay ? new Date(date.getTime() + 86_400_000) : date;
	return limit.getTime() < now.getTime();
}
