/**
 * La barra de la ventana del calendario.
 *
 * Tenía su propio marco y su propia barra escritos a mano, con un absoluto
 * propio para poner el mes en el medio. Ahora los tres salen de la librería.
 *
 * Lo que se comprueba es dónde queda cada cosa, que es lo que se rompe al
 * mudarla: el icono pegado al principio, el mes centrado respecto de la ventana
 * entera, y el botón de actualizar junto a los de la ventana. Una ranura mal
 * conectada no da ningún error: lo que se le ponga desaparece.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { AppBar, WindowControls, WindowFrame } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import CalendarioView from '@/views/CalendarioView.vue';
import { olvidarTodo } from './dobles';

let vista: VueWrapper | null = null;
/** Lo que cada llamada a `ranura()` dejó montado, para desmontarlo después. */
const sueltos: VueWrapper[] = [];

function abrir() {
	vista = mount(CalendarioView);
	return vista;
}

afterEach(() => {
	for (const suelto of sueltos.splice(0)) suelto.unmount();
	vista?.unmount();
	vista = null;
	olvidarTodo();
});

describe('la ventana', () => {
	test('usa el marco compartido', () => {
		expect(abrir().findComponent(WindowFrame).exists()).toBe(true);
	});

	test('y no queda un segundo borde dibujado a mano', () => {
		// `rounded-corner-window` es la esquina de la ventana y sale del marco.
		// Con dos, el borde y el fondo se dibujan dos veces y se ven los dos.
		expect(abrir().findAll('.rounded-corner-window').length).toBe(1);
	});

	test('con los tres botones', () => {
		// El calendario es una ventana normal: se minimiza, se maximiza y se
		// cierra.
		expect(abrir().findComponent(WindowControls).findAll('button')).toHaveLength(3);
	});

	test('y los tres con nombre, sin que esta ventana se lo pase', () => {
		// El envoltorio les pasaba las tres etiquetas a mano. Desde la 0.8 los
		// controles las resuelven solos contra el catálogo de la aplicación, y
		// son las mismas tres claves: repetirlas era dar la misma respuesta dos
		// veces. Lo que se comprueba es que al dejar de pasarlas **no se
		// pierdan**, que es lo que no daría ningún error —un botón que sólo
		// tiene un icono adentro se anuncia «botón» y nada más—.
		const botones = abrir().findComponent(WindowControls).findAll('button');

		expect(botones.map((b) => b.attributes('aria-label'))).toEqual([
			'ventana.minimizar',
			'ventana.maximizar',
			'ventana.cerrar',
		]);
	});
});

describe('lo que va en la barra', () => {
	/**
	 * Lo que se dibuja dentro de una ranura de la barra.
	 *
	 * Se pregunta por la ranura y no por la posición en el DOM: puesto en el
	 * contenido de la barra, un botón igual termina cerca de donde iba, así que
	 * mirar quién está al lado de quién no distingue nada. La cadena que esto
	 * comprueba es larga —la vista se la pasa al layout, el layout al marco, el
	 * marco a la barra— y basta con que uno de los tres no la reexponga para que
	 * lo que se le ponga desaparezca sin ningún error.
	 *
	 * Lo que monta **no** cuelga de `vista`, así que no se va con ella: se anota
	 * y el `afterEach` lo desmonta.
	 */
	function ranura(ventana: VueWrapper, nombre: string) {
		const barra = ventana.findComponent(AppBar);
		const dibujar = (barra.vm.$slots as Record<string, (() => unknown) | undefined>)[nombre];
		if (!dibujar) return null;
		const suelto = mount({ render: () => dibujar() });
		sueltos.push(suelto);
		return suelto;
	}

	test('el icono va en `identidad`', () => {
		// En la ranura del contenido se desplazaría con lo demás cuando la
		// barra queda a un costado y la lista no entra: `identidad` es la única
		// que no scrollea.
		const dentro = ranura(abrir(), 'identidad');

		expect(dentro).not.toBeNull();
		expect(dentro?.find('img').attributes('alt')).toBe('app.nombre');
	});

	test('el mes va al medio de la ventana entera y no entre columnas', () => {
		// Centrado entre el icono y los tres controles queda centrado respecto
		// de lo que sobra, y los controles ocupan bastante más que el icono: se
		// corre lo suficiente como para que se note.
		const ventana = abrir();
		const anterior = ventana.find('[aria-label="calendario.mesAnterior"]');

		expect(anterior.exists()).toBe(true);
		const envoltorio = anterior.element.closest('.absolute') as HTMLElement | null;
		expect(envoltorio).not.toBeNull();
		expect(envoltorio?.className).toContain('left-1/2');
	});

	test('actualizar va en `acciones`, que es lo pegado a los botones', () => {
		// Es donde está en el resto de las aplicaciones. Antes lo empujaba hasta
		// ahí un `span` con `flex-1`; ahora el hueco lo pone la barra sola.
		const dentro = ranura(abrir(), 'acciones');

		expect(dentro).not.toBeNull();
		expect(dentro?.find('[aria-label="calendario.actualizar"]').exists()).toBe(true);
	});

	test('y no quedó ningún hueco a mano empujando cosas', () => {
		const ventana = abrir();

		expect(ventana.findComponent(AppBar).findAll('span.flex-1').length).toBe(0);
	});
});
