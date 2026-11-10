/**
 * La lógica de la grilla horaria: dónde cae cada evento en la columna de un día
 * y cómo se reparten los que se pisan. Se comprueba que la hora sale de la zona
 * de la agenda y no de la del sistema.
 */

import { describe, expect, setSystemTime, test } from 'bun:test';
import { mount } from '@vue/test-utils';
import TimeGridView from '@/components/calendar/TimeGridView.vue';
import { eventsByDay } from '@/tools/mes';
import { viewDays } from '@/tools/views';
import {
	allDayOf,
	buildTimeChange,
	dragRange,
	draggedValues,
	eventRangeOn,
	isDraggableOn,
	minutesOfDay,
	placeEvents,
} from '@/tools/time-grid';
import { calendarEvent as event } from './fixtures/events';

const DAY = '2026-09-15';
const MIN = 20;

const at = (uid: string, start: string, end: string) =>
	event({ uid, start: `2026-09-15T${start}:00Z`, end: `2026-09-15T${end}:00Z` });

describe('minutos desde la medianoche', () => {
	test('salen de la zona de la agenda, no del sistema', () => {
		const instant = new Date('2026-09-15T14:30:00Z');
		expect(minutesOfDay(instant, 'UTC')).toBe(14 * 60 + 30);
		// Buenos Aires es UTC-3 todo el año.
		expect(minutesOfDay(instant, 'America/Argentina/Buenos_Aires')).toBe(11 * 60 + 30);
	});
});

describe('el tramo de un evento en el día', () => {
	test('un rango va de su comienzo a su fin', () => {
		expect(eventRangeOn(at('a', '09:00', '10:30'), DAY, 'UTC', MIN)).toEqual({
			startMin: 540,
			endMin: 630,
		});
	});

	test('uno corto se agranda al mínimo tocable', () => {
		expect(eventRangeOn(at('a', '09:00', '09:05'), DAY, 'UTC', MIN)).toEqual({
			startMin: 540,
			endMin: 560,
		});
	});

	test('un instante sin final también tiene alto', () => {
		const e = event({ start: '2026-09-15T09:00:00Z', end: '' });
		expect(eventRangeOn(e, DAY, 'UTC', MIN)).toEqual({ startMin: 540, endMin: 560 });
	});

	test('el que sigue al día siguiente llega al fin del día, y el que viene del anterior arranca a las 0:00', () => {
		const night = event({ start: '2026-09-15T22:00:00Z', end: '2026-09-16T06:00:00Z' });
		expect(eventRangeOn(night, DAY, 'UTC', MIN)).toEqual({ startMin: 1320, endMin: 1440 });
		expect(eventRangeOn(night, '2026-09-16', 'UTC', MIN)).toEqual({ startMin: 0, endMin: 360 });
	});

	test('el tramo se mide en la zona de la agenda: un rango que en UTC cae el 16 es del 15 en Buenos Aires', () => {
		const ba = 'America/Argentina/Buenos_Aires';
		const late = event({ start: '2026-09-16T01:00:00Z', end: '2026-09-16T02:00:00Z' });
		expect(eventRangeOn(late, DAY, ba, MIN)).toEqual({ startMin: 22 * 60, endMin: 23 * 60 });
		expect(eventRangeOn(at('a', '12:00', '13:30'), DAY, ba, MIN)).toEqual({
			startMin: 9 * 60,
			endMin: 10 * 60 + 30,
		});
	});

	test('el que termina a medianoche cierra el día', () => {
		expect(eventRangeOn(at('a', '22:00', '23:00'), DAY, 'UTC', MIN)?.endMin).toBe(
			23 * 60
		);
		const e = event({ start: '2026-09-15T22:00:00Z', end: '2026-09-16T00:00:00Z' });
		expect(eventRangeOn(e, DAY, 'UTC', MIN)).toEqual({ startMin: 1320, endMin: 1440 });
	});

	test('uno a las 23:59 no se sale del día', () => {
		const e = event({ start: '2026-09-15T23:59:00Z', end: '2026-09-15T23:59:30Z' });
		expect(eventRangeOn(e, DAY, 'UTC', MIN)).toEqual({ startMin: 1420, endMin: 1440 });
	});

	test('el de todo el día no tiene tramo y va a la franja de arriba', () => {
		const all = event({ all_day: true });
		expect(eventRangeOn(all, DAY, 'UTC', MIN)).toBeNull();
		expect(allDayOf([all, at('a', '09:00', '10:00')], DAY, 'UTC')).toEqual([all]);
		// Uno de varios días, en un día del medio, tampoco tiene hora que mostrar.
		const long = event({ start: '2026-09-14T10:00:00Z', end: '2026-09-16T10:00:00Z' });
		expect(allDayOf([long], DAY, 'UTC')).toEqual([long]);
		expect(allDayOf([long], '2026-09-14', 'UTC')).toEqual([]);
	});
});

describe('el reparto de los que se pisan', () => {
	const place = (events: ReturnType<typeof at>[]) =>
		placeEvents(events, DAY, 'UTC', MIN).map((p) => [p.event.uid, p.column, p.columns]);

	test('uno solo ocupa todo el ancho', () => {
		expect(place([at('a', '09:00', '10:00')])).toEqual([['a', 0, 1]]);
	});

	test('los que se tocan sólo en el borde no se reparten', () => {
		expect(place([at('a', '09:00', '10:00'), at('b', '10:00', '11:00')])).toEqual([
			['a', 0, 1],
			['b', 0, 1],
		]);
	});

	test('dos que se pisan quedan lado a lado', () => {
		expect(place([at('a', '09:00', '10:00'), at('b', '09:30', '10:30')])).toEqual([
			['a', 0, 2],
			['b', 1, 2],
		]);
	});

	test('una cadena comparte el ancho de su grupo y reusa la columna libre', () => {
		// a pisa b, b pisa c, pero c ya no pisa a: c vuelve a la columna 0.
		expect(
			place([at('a', '09:00', '10:00'), at('b', '09:30', '11:00'), at('c', '10:00', '10:30')])
		).toEqual([
			['a', 0, 2],
			['b', 1, 2],
			['c', 0, 2],
		]);
	});

	test('un grupo posterior vuelve a empezar con su propio ancho', () => {
		expect(
			place([at('a', '09:00', '10:00'), at('b', '09:00', '10:00'), at('c', '12:00', '13:00')])
		).toEqual([
			['a', 0, 2],
			['b', 1, 2],
			['c', 0, 1],
		]);
	});

	test('el que arranca justo cuando termina un grupo no hereda su ancho', () => {
		expect(
			place([at('a', '09:00', '10:00'), at('b', '09:00', '10:00'), at('c', '10:00', '11:00')])
		).toEqual([
			['a', 0, 2],
			['b', 1, 2],
			['c', 0, 1],
		]);
	});

	test('el orden en que llegan no cambia el reparto', () => {
		expect(place([at('b', '09:30', '10:30'), at('a', '09:00', '10:00')])).toEqual([
			['a', 0, 2],
			['b', 1, 2],
		]);
	});

	test('tres que se pisan a la vez se reparten en tres', () => {
		expect(
			place([at('a', '09:00', '10:00'), at('b', '09:10', '10:00'), at('c', '09:20', '10:00')])
		).toEqual([
			['a', 0, 3],
			['b', 1, 3],
			['c', 2, 3],
		]);
	});

	test('dos eventos cortos pegados se separan por el mínimo tocable', () => {
		expect(place([at('a', '09:00', '09:05'), at('b', '09:10', '09:15')])).toEqual([
			['a', 0, 2],
			['b', 1, 2],
		]);
	});
});

describe('la vista de grilla', () => {
	const days = viewDays('days', new Date('2026-09-15T12:00:00Z'), 'UTC', new Date('2026-09-15T12:00:00Z'));
	const mountGrid = (events: ReturnType<typeof at>[], zone = 'UTC') => {
		const byDay = eventsByDay(events, days, zone);
		return mount(TimeGridView, {
			props: { days, zone, eventsOf: (key: string) => byDay.get(key) ?? [] },
		});
	};

	test('un bloque por evento, posicionado por la hora de la zona, y un toque lo abre', async () => {
		const meeting = at('a', '09:00', '10:00');
		const wrapper = mountGrid([meeting]);
		const block = wrapper.get('[data-testid="time-block"]');
		expect(block.attributes('style')).toContain('top: 540px');
		expect(block.attributes('style')).toContain('height: 60px');
		await block.trigger('click');
		expect(wrapper.emitted('open')?.[0]).toEqual([meeting]);
		wrapper.unmount();
	});

	test('en otra zona el mismo evento cae a otra hora', () => {
		const wrapper = mountGrid([at('a', '09:00', '10:00')], 'America/Argentina/Buenos_Aires');
		expect(wrapper.get('[data-testid="time-block"]').attributes('style')).toContain('top: 360px');
		wrapper.unmount();
	});

	test('el de todo el día va arriba y no es un bloque', () => {
		const wrapper = mountGrid([event({ all_day: true })]);
		expect(wrapper.findAll('[data-testid="all-day-event"]')).toHaveLength(1);
		expect(wrapper.findAll('[data-testid="time-block"]')).toHaveLength(0);
		wrapper.unmount();
	});

	test('el color del calendario es una marca, no el fondo del bloque', () => {
		const wrapper = mountGrid([at('a', '09:00', '10:00')]);
		expect(wrapper.get('[data-testid="time-block"]').attributes('style')).not.toContain('color');
		expect(wrapper.get('[data-testid="event-color"]').attributes('style')).toContain('background-color');
		wrapper.unmount();
	});

	test('la línea de ahora cae en la columna de hoy, a la hora de la zona', () => {
		setSystemTime(new Date('2026-09-15T12:00:00Z'));
		try {
			const wrapper = mountGrid([], 'America/Argentina/Buenos_Aires');
			const line = wrapper.get('[data-testid="now-line"]');
			expect(line.attributes('style')).toContain('top: 540px');
			wrapper.unmount();
		} finally {
			setSystemTime();
		}
	});
});

describe('mover y estirar: la cuenta', () => {
	const range = { startMin: 540, endMin: 600 };

	test('mover corre el comienzo con snap a 15 min y conserva la duración', () => {
		expect(dragRange('move', range, 22)).toEqual({ startMin: 555, endMin: 615 });
		expect(dragRange('move', range, 6)).toEqual({ startMin: 540, endMin: 600 });
	});

	test('mover no se sale del día', () => {
		expect(dragRange('move', range, -900)).toEqual({ startMin: 0, endMin: 60 });
		expect(dragRange('move', range, 9000)).toEqual({ startMin: 1380, endMin: 1440 });
	});

	test('estirar corre el fin con snap, con duración mínima y tope en las 24:00', () => {
		expect(dragRange('resize', range, 40)).toEqual({ startMin: 540, endMin: 645 });
		expect(dragRange('resize', range, -500)).toEqual({ startMin: 540, endMin: 555 });
		expect(dragRange('resize', range, 9000)).toEqual({ startMin: 540, endMin: 1440 });
	});
});

describe('mover y estirar: el parche', () => {
	const ev = event({ uid: 'acc/7', calendar: 'acc/3', etag: '"e1"', start: '2026-09-15T09:00:00Z', end: '2026-09-15T09:40:00Z' });

	test('el parche lleva sólo id, start y end, y la cuenta y el calendario salen de los ids', () => {
		const values = draggedValues('move', ev, 'UTC', DAY, { startMin: 600, endMin: 640 });
		expect(values).toEqual({ start: '2026-09-15T10:00', end: '2026-09-15T10:40' });
		const built = buildTimeChange(ev, 'UTC', values);
		expect(built?.accountId).toBe('acc');
		expect(built?.calendarId).toBe('3');
		expect(Object.keys(built?.patch ?? {}).sort()).toEqual(['end', 'id', 'start']);
		expect(built?.patch.id).toBe(7);
	});

	test('mover conserva la duración real y pasa de día; estirar deja el comienzo', () => {
		expect(draggedValues('move', ev, 'UTC', '2026-09-17', { startMin: 600, endMin: 620 })).toEqual({
			start: '2026-09-17T10:00',
			end: '2026-09-17T10:40',
		});
		expect(draggedValues('resize', ev, 'UTC', DAY, { startMin: 540, endMin: 1440 })).toEqual({
			start: '2026-09-15T09:00',
			end: '2026-09-16T00:00',
		});
	});

	test('un id que no se puede escribir no arma parche', () => {
		expect(buildTimeChange(event({ uid: 'uno' }), 'UTC', { start: '2026-09-15T10:00', end: null })).toBeNull();
	});

	test('sin ETag, de todo el día o recortado por el día, no se arrastra', () => {
		expect(isDraggableOn(ev, DAY, 'UTC')).toBe(true);
		expect(isDraggableOn({ ...ev, etag: null }, DAY, 'UTC')).toBe(false);
		expect(isDraggableOn({ ...ev, all_day: true }, DAY, 'UTC')).toBe(false);
		expect(isDraggableOn({ ...ev, end: '2026-09-16T06:00:00Z' }, DAY, 'UTC')).toBe(false);
	});
});

describe('mover y estirar: la interacción', () => {
	const days = viewDays('days', new Date('2026-09-15T12:00:00Z'), 'UTC', new Date('2026-09-15T12:00:00Z'));
	const ev = event({ uid: 'acc/7', calendar: 'acc/3', etag: '"e1"', start: '2026-09-15T09:00:00Z', end: '2026-09-15T10:00:00Z' });
	const mountGrid = (e: typeof ev) => {
		const byDay = eventsByDay([e], days, 'UTC');
		return mount(TimeGridView, { props: { days, zone: 'UTC', eventsOf: (k: string) => byDay.get(k) ?? [] } });
	};
	const ptr = (clientY: number) => ({ button: 0, pointerId: 1, clientX: 10, clientY });
	Element.prototype.setPointerCapture ??= () => {};

	test('arrastrar el cuerpo lo mueve con snap y no abre el evento', async () => {
		const wrapper = mountGrid(ev);
		const block = wrapper.get('[data-testid="time-block"]');
		await block.trigger('pointerdown', ptr(100));
		await block.trigger('pointermove', ptr(130));
		expect(wrapper.find('[data-testid="drag-ghost"]').exists()).toBe(true);
		await block.trigger('pointerup', ptr(130));
		await block.trigger('click');
		expect(wrapper.emitted('change')?.[0]).toEqual([{ event: ev, start: '2026-09-15T09:30', end: '2026-09-15T10:30' }]);
		expect(wrapper.emitted('open')).toBeUndefined();
		wrapper.unmount();
	});

	test('la manija estira el fin', async () => {
		const wrapper = mountGrid(ev);
		await wrapper.get('[data-testid="resize-handle"]').trigger('pointerdown', ptr(100));
		await wrapper.get('[data-testid="time-block"]').trigger('pointermove', ptr(145));
		await wrapper.get('[data-testid="time-block"]').trigger('pointerup', ptr(145));
		expect(wrapper.emitted('change')?.[0]).toEqual([{ event: ev, start: '2026-09-15T09:00', end: '2026-09-15T10:45' }]);
		wrapper.unmount();
	});

	test('un toque sin pasar el umbral abre el evento y no cambia nada', async () => {
		const wrapper = mountGrid(ev);
		const block = wrapper.get('[data-testid="time-block"]');
		await block.trigger('pointerdown', ptr(100));
		await block.trigger('pointermove', ptr(102));
		await block.trigger('pointerup', ptr(102));
		await block.trigger('click');
		expect(wrapper.emitted('change')).toBeUndefined();
		expect(wrapper.emitted('open')).toHaveLength(1);
		wrapper.unmount();
	});

	test('sin ETag no hay manija ni arrastre', async () => {
		const wrapper = mountGrid({ ...ev, etag: null });
		const block = wrapper.get('[data-testid="time-block"]');
		expect(wrapper.find('[data-testid="resize-handle"]').exists()).toBe(false);
		await block.trigger('pointerdown', ptr(100));
		await block.trigger('pointermove', ptr(160));
		await block.trigger('pointerup', ptr(160));
		expect(wrapper.emitted('change')).toBeUndefined();
		wrapper.unmount();
	});
});
