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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AppBar, olvidarLosIconosDelTema, WindowControls, WindowFrame } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import CalendarioView from '@/views/CalendarioView.vue';
import { olvidarTodo } from './dobles';

let vista: VueWrapper | null = null;
/** Lo que cada llamada a `ranura()` dejó montado, para desmontarlo después. */
const sueltos: VueWrapper[] = [];

function abrir() {
	vista = mount(CalendarioView);
	return vista;
}

/**
 * Deja que `ThemeIcon` resuelva.
 *
 * El icono se pide al montar y vuelve por promesa, así que hasta que no vuelve
 * el componente dibuja el hueco del mismo tamaño y no una imagen. Sin esperar,
 * buscar `img` no encuentra nada y la prueba falla por la razón equivocada.
 */
async function asentar(vueltas = 6) {
	for (let i = 0; i < vueltas; i++) await nextTick();
}

/**
 * La memoria de iconos de la librería, vaciada de los dos lados.
 *
 * Vive en su módulo y el módulo se comparte entre archivos de prueba, así que
 * lo que queda guardado acá lo ve el archivo que corra después. El `beforeEach`
 * protege a este archivo de lo que dejó otro; el `afterEach` protege a los
 * demás de lo que deja éste.
 *
 * Hoy los dobles devuelven siempre lo mismo para un nombre —`icono:calendar` y
 * nada más—, así que una entrada vieja no puede mentir. Va igual: el día que
 * alguien pueda configurar qué devuelve el tema de mentira, esa entrada pasa a
 * ser un valor equivocado que sobrevive a la prueba que lo puso, y eso no falla
 * donde se escribió sino en el archivo siguiente. Lo marcó CodeRabbit.
 */
beforeEach(() => {
	olvidarLosIconosDelTema();
});

afterEach(() => {
	for (const suelto of sueltos.splice(0)) suelto.unmount();
	vista?.unmount();
	vista = null;
	olvidarTodo();
	olvidarLosIconosDelTema();
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

	test('el icono va en `identidad`', async () => {
		// En la ranura del contenido se desplazaría con lo demás cuando la
		// barra queda a un costado y la lista no entra: `identidad` es la única
		// que no scrollea.
		const dentro = ranura(abrir(), 'identidad');
		await asentar();

		expect(dentro).not.toBeNull();
		expect(dentro?.find('img').attributes('alt')).toBe('app.nombre');
	});

	test('y es el de la aplicación, a color', async () => {
		// A color y no el símbolo: es la identidad de la ventana, como en el
		// resto del escritorio. El doble devuelve `icono:` o `simbolo:` según
		// cuál se haya pedido, que es lo que lo distingue —pedir el símbolo no
		// falla, dibuja otra cosa—.
		const dentro = ranura(abrir(), 'identidad');
		await asentar();

		expect(dentro?.find('img').attributes('src')).toBe('icono:calendar');
	});

	test('el mes va en el contenido de la barra, que es lo único que crece', () => {
		// Y no en `centro`, que centra respecto de la ventana entera: con el
		// icono de un lado y el estado, actualizar y los tres controles del
		// otro, el medio de la ventana no es el medio del hueco.
		const dentro = ranura(abrir(), 'default');

		expect(dentro).not.toBeNull();
		expect(dentro?.find('[aria-label="calendario.mesAnterior"]').exists()).toBe(true);
	});

	test('y ya no queda nada en `centro`', () => {
		// La ranura sigue existiendo en el marco, y llenar las dos pondría dos
		// barras: la de `centro` va encima, así que se verían las dos a la vez y
		// superpuestas.
		expect(ranura(abrir(), 'centro')).toBeNull();
	});

	test('centrado en el hueco, con márgenes automáticos', () => {
		// `m-auto` reparte lo que sobra del contenedor a los dos lados. Sin él
		// el grupo se pega al principio de la barra: el contenedor es flexible
		// y los hijos no se centran solos.
		//
		// En los dos ejes y no sólo el horizontal: con la barra a un costado el
		// hueco es vertical, y el margen automático centra en el eje que
		// corresponda sin que haya que preguntar cuál es.
		const dentro = ranura(abrir(), 'default');

		expect(dentro?.find('div').classes()).toContain('m-auto');
	});

	test('y «Hoy» se centra junto al mes y no aparte', () => {
		// Son una sola cosa para el ojo. Con el botón fuera del envoltorio, lo
		// centrado sería el mes solo y «Hoy» quedaría colgando de un lado.
		const dentro = ranura(abrir(), 'default');
		const envoltorio = dentro?.find('.m-auto');

		expect(envoltorio?.text()).toContain('calendario.hoy');
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
