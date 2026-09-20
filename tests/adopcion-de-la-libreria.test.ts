/**
 * Lo que cambia al adoptar la librería.
 *
 * El calendario tenía su propio selector con búsqueda y su propia copia del
 * orden de las coincidencias. Las dos cosas existían igual en vasak-installer,
 * y el comentario de la copia de acá ya decía que el día que hubiera un
 * paquete común se iban las dos. Es hoy.
 *
 * Lo que se comprueba acá es lo del calendario y no lo del componente: que la
 * lista de zonas siga armándose como antes —la del sistema primero, la ciudad
 * adelante y la región al costado— y que elegir una siga avisando. Cómo se
 * recorre el desplegable con el teclado y cómo se cierra es de la librería y se
 * prueba allá.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { SearchSelect } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ZonaComponent from '@/components/calendario/ZonaComponent.vue';
import { olvidarTodo } from './dobles';

let vista: VueWrapper | null = null;

function armar(props: Record<string, unknown> = {}) {
	vista = mount(ZonaComponent, {
		props: { elegida: '', delSistema: 'America/Argentina/Buenos_Aires', enUso: 'America/Argentina/Buenos_Aires', ajena: false, ...props },
		attachTo: document.body,
	});
	return vista;
}

const elSelector = (v: VueWrapper) => v.findComponent(SearchSelect);

afterEach(() => {
	vista?.unmount();
	vista = null;
	for (const suelto of document.body.querySelectorAll('[role="listbox"]')) suelto.remove();
	olvidarTodo();
});

describe('el selector de zona', () => {
	test('es el de la librería y no una copia de acá', () => {
		// Es lo que le trae el teclado completo y el cierre al salir el foco.
		expect(elSelector(armar()).exists()).toBe(true);
	});

	test('la del sistema va primera y vale la cadena vacía', () => {
		// Es la que casi todo el mundo quiere, y la que hay que poder recuperar
		// de un golpe después de probar otra. Vacía es como se dice «seguí al
		// sistema» en el resto del código.
		const opciones = elSelector(armar()).props('options') as { valor: string }[];

		expect(opciones[0].valor).toBe('');
	});

	test('y no aparece dos veces', () => {
		// La del sistema se saca del resto de la lista: si no, está arriba y
		// otra vez en su lugar alfabético, y elegir una u otra hace cosas
		// distintas —una sigue al sistema y la otra la fija—.
		const opciones = elSelector(armar()).props('options') as { valor: string }[];

		expect(opciones.filter((o) => o.valor === 'America/Argentina/Buenos_Aires')).toHaveLength(0);
	});

	test('la ciudad adelante y la región al costado', () => {
		// Con el nombre entero de IANA, la segunda columna repetía la primera y
		// en un panel angosto quedaba cortado justo en la parte que dice cuál es.
		const opciones = elSelector(armar()).props('options') as {
			valor: string;
			etiqueta: string;
			detalle?: string;
		}[];
		const madrid = opciones.find((o) => o.valor === 'Europe/Madrid');

		expect(madrid?.etiqueta).toBe('Madrid');
		expect(madrid?.detalle).toBe('Europe');
	});

	test('se abre hacia arriba, porque vive al pie del panel', () => {
		// Hacia abajo el menú se sale de la ventana y no hay forma de llegar al
		// final de la lista.
		expect(elSelector(armar()).props('up')).toBe(true);
	});

	test('elegir una avisa hacia afuera', async () => {
		// La aplicación decide qué hacer con la zona; el componente sólo la
		// ofrece. Es la cadena que se rompería al cambiar de componente.
		const v = armar();
		elSelector(v).vm.$emit('update:modelValue', 'Europe/Madrid');
		await nextTick();

		expect(v.emitted('elegir')?.[0]).toEqual(['Europe/Madrid']);
	});
});
