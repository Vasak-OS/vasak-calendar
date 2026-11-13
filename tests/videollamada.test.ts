/** El botón «Unirse»: el enlace de la videollamada llega en el detalle y se abre sólo al tocar. */

import { afterEach, describe, expect, test } from 'bun:test';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EventDialog from '@/components/calendar/EventDialog.vue';
import { getEvent } from '@/composables/use-calendario';
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

async function abrir() {
	vista = mount(EventDialog, {
		props: { open: true, mode: 'edit', calendars: [], zone: 'UTC', event },
		attachTo: document.body,
	});
	await flushPromises();
}

const botonUnirse = () =>
	[...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('videollamada.unirse'));
const aperturas = () => invocations.filter((i) => i.command === 'plugin:shell|open');

describe('enlace de videollamada en el detalle', () => {
	test('getEvent lee meeting_url como meetingUrl', async () => {
		setAnswer('get_event', JSON.stringify({ meeting_url: 'https://meet.example.org/abc' }));
		expect((await getEvent('google/42'))?.meetingUrl).toBe('https://meet.example.org/abc');
	});

	test('sin meeting_url, o con un tipo que no es texto, meetingUrl queda vacío', async () => {
		for (const json of ['{}', '{"meeting_url":null}', '{"meeting_url":5}', '{"meeting_url":{"a":1}}']) {
			setAnswer('get_event', json);
			expect((await getEvent('google/42'))?.meetingUrl).toBe('');
		}
	});
});

describe('botón Unirse del diálogo', () => {
	test('con enlace aparece, y al tocarlo se abre exactamente esa URL', async () => {
		setAnswer('get_event', JSON.stringify({ meeting_url: 'https://meet.example.org/abc?pwd=1' }));
		await abrir();
		expect(aperturas()).toHaveLength(0); // nunca se abre solo
		botonUnirse()?.click();
		await flushPromises();
		expect(aperturas()).toHaveLength(1);
		expect((aperturas()[0].args as { path: string }).path).toBe('https://meet.example.org/abc?pwd=1');
	});

	test('sin enlace no hay botón', async () => {
		setAnswer('get_event', JSON.stringify({ meeting_url: '' }));
		await abrir();
		expect(botonUnirse()).toBeUndefined();
		expect(document.body.innerHTML).not.toContain('videollamada.unirse');
	});

	test('si no se puede abrir el enlace, se avisa y el diálogo sigue', async () => {
		setAnswer('get_event', JSON.stringify({ meeting_url: 'https://meet.example.org/abc' }));
		setFailure('plugin:shell|open', 'sin navegador');
		await abrir();
		botonUnirse()?.click();
		await flushPromises();
		expect(document.body.innerHTML).toContain('videollamada.noSePudoAbrir');
		expect(botonUnirse()).toBeDefined();
	});
});
