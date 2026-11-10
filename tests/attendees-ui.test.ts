/** Las invitaciones del evento: se piden al abrir uno existente y sólo se muestran. */

import { afterEach, describe, expect, test } from 'bun:test';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EventDialog from '@/components/calendar/EventDialog.vue';
import type { CalendarEvent } from '@/tools/mes';
import { invocations, olvidarTodo, setAnswer, setFailure } from './dobles';

let vista: VueWrapper | null = null;

afterEach(() => {
	vista?.unmount();
	vista = null;
	olvidarTodo();
});

const event: CalendarEvent = {
	uid: 'google/42',
	title: 'Reunión',
	start: '2026-09-15T14:00:00+00:00',
	end: '2026-09-15T15:00:00+00:00',
	all_day: false,
	recurring: false,
	shown_once: false,
	zone: '',
	calendar: 'google/1',
	color: null,
	etag: '"etag-1"',
	sync_state: 'synced',
};

async function abrir(mode: 'edit' | 'create' = 'edit') {
	vista = mount(EventDialog, {
		props: { open: true, mode, calendars: [], zone: 'UTC', event: mode === 'edit' ? event : null },
		attachTo: document.body,
	});
	await flushPromises();
}

describe('invitaciones en el diálogo del evento', () => {
	test('al abrir un evento existente pide el detalle y muestra organizador y asistentes como texto', async () => {
		setAnswer(
			'get_event',
			JSON.stringify({
				organizer: { name: '', email: 'jefa@x.org', status: 'accepted' },
				attendees: [
					{ name: '<b>Ana</b>', email: 'ana@x.org', status: 'declined' },
					{ name: '', email: 'beto@x.org', status: '' },
				],
			})
		);
		await abrir();
		expect(invocations.find((i) => i.command === 'get_event')?.args).toEqual({
			eventId: 'google/42',
			occurrenceId: '',
		});
		const html = document.body.innerHTML;
		expect(html).toContain('invitaciones.titulo');
		expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
		expect(document.body.querySelector('section b')).toBeNull();
		expect(html).toContain('beto@x.org');
		expect(html).toContain('invitaciones.rechazado');
		expect(html).toContain('invitaciones.sinEstado');
	});

	test('sin organizador ni asistentes no hay sección', async () => {
		setAnswer('get_event', JSON.stringify({ organizer: null, attendees: [] }));
		await abrir();
		expect(document.body.innerHTML).not.toContain('invitaciones.titulo');
	});

	test('si el detalle falla el diálogo se muestra igual, con el aviso', async () => {
		setFailure('get_event', 'sin permiso');
		await abrir();
		expect(document.body.innerHTML).toContain('invitaciones.noSePudo');
		expect(document.body.innerHTML).toContain('editor.guardar');
	});

	test('al crear no se pide el detalle', async () => {
		await abrir('create');
		expect(invocations.some((i) => i.command === 'get_event')).toBe(false);
	});
});
