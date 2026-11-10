/** Las invitaciones del evento: se piden al abrir uno existente y sólo se muestran. */

import { afterEach, describe, expect, test } from 'bun:test';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EventDialog from '@/components/calendar/EventDialog.vue';
import { getEvent } from '@/composables/use-calendario';
import { buildRsvp } from '@/tools/event-form';
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

async function abrir(
	mode: 'edit' | 'create' = 'edit',
	extra: Record<string, unknown> = {},
	ev: CalendarEvent = event
) {
	vista = mount(EventDialog, {
		props: { open: true, mode, calendars: [], zone: 'UTC', event: mode === 'edit' ? ev : null, ...extra },
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

	test('cada estado se muestra con su texto y lo desconocido o vacío es «—»', async () => {
		const estados = ['accepted', 'declined', 'needs-action', 'tentative', '', 'raro'];
		setAnswer(
			'get_event',
			JSON.stringify({
				organizer: null,
				attendees: estados.map((status, i) => ({ name: '', email: `p${i}@x.org`, status })),
			})
		);
		await abrir();
		const metas = [...document.body.querySelectorAll('section [role=group] > *')].map((li) => li.textContent ?? '');
		const esperado = [
			'invitaciones.aceptado',
			'invitaciones.rechazado',
			'invitaciones.pendiente',
			'invitaciones.tentativo',
			'invitaciones.sinEstado',
			'invitaciones.sinEstado',
		];
		expect(metas).toHaveLength(6);
		esperado.forEach((clave, i) => {
			expect(metas[i]).toContain(clave);
		});
	});

	test('el estado en mayúsculas se entiende igual', async () => {
		setAnswer(
			'get_event',
			JSON.stringify({ organizer: null, attendees: [{ name: '', email: 'a@x.org', status: 'NEEDS-ACTION' }] })
		);
		await abrir();
		expect(document.body.innerHTML).toContain('invitaciones.pendiente');
	});

	test('con sólo organizador la sección aparece, y con sólo asistentes también', async () => {
		setAnswer('get_event', JSON.stringify({ organizer: { name: 'Ana', email: 'a@x.org', status: '' }, attendees: [] }));
		await abrir();
		expect(document.body.innerHTML).toContain('invitaciones.titulo');
		vista?.unmount();
		setAnswer('get_event', JSON.stringify({ organizer: null, attendees: [{ name: '', email: 'b@x.org', status: '' }] }));
		await abrir();
		expect(document.body.innerHTML).toContain('b@x.org');
	});

	test('si se abre otro evento, la respuesta tardía del anterior no se pinta', async () => {
		const pendientes: Record<string, (v: string) => void> = {};
		setAnswer(
			'get_event',
			(args: { eventId: string }) => new Promise<string>((ok) => {
				pendientes[args.eventId] = ok;
			})
		);
		await abrir();
		await vista?.setProps({ event: { ...event, uid: 'google/43' } });
		await flushPromises();
		pendientes['google/43'](
			JSON.stringify({ organizer: null, attendees: [{ name: '', email: 'nueva@x.org', status: '' }] })
		);
		await flushPromises();
		pendientes['google/42'](
			JSON.stringify({ organizer: null, attendees: [{ name: '', email: 'vieja@x.org', status: '' }] })
		);
		await flushPromises();
		expect(document.body.innerHTML).toContain('nueva@x.org');
		expect(document.body.innerHTML).not.toContain('vieja@x.org');
	});
});

describe('responder una invitación', () => {
	const detalle = (my: string, soy = true) =>
		JSON.stringify({
			organizer: null,
			attendees: [{ name: '', email: 'yo@x.org', status: my }],
			am_i_attendee: soy,
			my_response: my,
		});
	const botones = () =>
		[...document.body.querySelectorAll('[role=group][aria-label="invitaciones.tuRespuesta"] button')] as HTMLButtonElement[];

	test('el parche lleva sólo id numérico y partstat, con cuenta y calendario sacados del evento', () => {
		const r = buildRsvp({ uid: 'acc.x/42', calendar: 'acc.x/7' }, 'tentative');
		expect(r).toEqual({ accountId: 'acc.x', calendarId: '7', patch: { id: 42, partstat: 'tentative' } });
		expect(Object.keys(r?.patch ?? {}).sort()).toEqual(['id', 'partstat']);
		expect(typeof r?.patch.id).toBe('number');
	});

	test('con un uid sin id local válido no hay parche', () => {
		for (const uid of ['x', 'google/', 'google/abc', 'google/0', 'google/-3', 'google/1.5']) {
			expect(buildRsvp({ uid, calendar: 'google/1' }, 'accepted')).toBeNull();
		}
		expect(buildRsvp({ uid: 'google/42', calendar: 'sin-barra' }, 'accepted')).toBeNull();
	});

	test('el detalle lee am_i_attendee y my_response, con valores por omisión', async () => {
		setAnswer('get_event', JSON.stringify({ am_i_attendee: true, my_response: 'declined' }));
		expect(await getEvent('google/42')).toMatchObject({ amIAttendee: true, myResponse: 'declined' });
		setAnswer('get_event', JSON.stringify({ am_i_attendee: 'true', my_response: 5 }));
		expect(await getEvent('google/42')).toMatchObject({ amIAttendee: false, myResponse: '' });
		setAnswer('get_event', '{}');
		expect(await getEvent('google/42')).toMatchObject({ amIAttendee: false, myResponse: '' });
	});

	test('con el evento en conflicto los botones no se ofrecen', async () => {
		setAnswer('get_event', detalle('accepted'));
		await abrir('edit', { respond: async () => null }, { ...event, sync_state: 'conflict' });
		expect(botones()).toHaveLength(0);
	});

	test('sin ser invitado o sin respond no hay botones', async () => {
		setAnswer('get_event', detalle('accepted', false));
		await abrir('edit', { respond: async () => null });
		expect(botones()).toHaveLength(0);
	});

	test('sin ETag los botones no se ofrecen', async () => {
		setAnswer('get_event', detalle('accepted'));
		await abrir('edit', { respond: async () => null }, { ...event, etag: null });
		expect(botones()).toHaveLength(0);
	});

	test('cada botón manda su partstat y, tras el OK, se relee el detalle', async () => {
		setAnswer('get_event', detalle('needs-action'));
		const llamadas: string[] = [];
		await abrir('edit', {
			respond: async (_e: CalendarEvent, p: string) => {
				llamadas.push(p);
				setAnswer('get_event', detalle(p));
				return null;
			},
		});
		expect(botones().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
		const pedidos = () => invocations.filter((i) => i.command === 'get_event').length;
		const antes = pedidos();
		botones()[1].click();
		await flushPromises();
		expect(pedidos()).toBe(antes + 1);
		expect(botones().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
		botones()[0].click();
		await flushPromises();
		botones()[2].click();
		await flushPromises();
		expect(llamadas).toEqual(['declined', 'accepted', 'tentative']);
		expect(botones().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
	});

	test('si falla se avisa y el diálogo sigue', async () => {
		setAnswer('get_event', detalle('accepted'));
		await abrir('edit', { respond: async () => 'boom' });
		botones()[2].click();
		await flushPromises();
		expect(document.body.innerHTML).toContain('boom');
		expect(botones()).toHaveLength(3);
		expect(botones().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
	});

	test('si respond revienta se avisa y el diálogo sigue', async () => {
		setAnswer('get_event', detalle('accepted'));
		await abrir('edit', {
			respond: async () => {
				throw new Error('red');
			},
		});
		botones()[1].click();
		await flushPromises();
		expect(document.body.innerHTML).toContain('invitaciones.noSePudo');
		expect(botones()).toHaveLength(3);
	});
});
