/**
 * Si la fila de la ventana está por debajo del ancho de dos columnas.
 *
 * Las columnas no lo necesitan: las acomoda la consulta de contenedor sobre la
 * fila (`tools/narrow-layout.ts`). Lo necesita lo que vive **fuera** de la
 * fila, como la barra de la ventana, que una consulta de contenedor no alcanza.
 *
 * Con un `ResizeObserver` sobre la fila y no con `matchMedia` ni `resize`:
 * WebKitGTK no avisa de ninguno de los dos (memoria
 * `webkitgtk-no-avisa-de-resize`), y la barra puede ir a un costado y comerse
 * parte del ancho, cosa que la pantalla no sabe.
 *
 * Un ancho de cero es «todavía no se maquetó», no «es angosta»: hasta la
 * primera medida se queda en ancha, que es como se ve hoy.
 */

import { onBeforeUnmount, onMounted, type Ref, ref, watch } from 'vue';
import { NARROW_ROW_REM } from '@/tools/narrow-layout';

/** El tamaño de un `rem`, en píxeles: el umbral va en rem, como la consulta. */
function remInPixels(): number {
	const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
	return Number.isFinite(size) && size > 0 ? size : 16;
}

/** Si un ancho de fila, en píxeles, es angosto. Cero es desconocido. */
export function isNarrowWidth(width: number, rem = 16): boolean {
	return width > 0 && width < NARROW_ROW_REM * rem;
}

export function useNarrowRow(target: Ref<HTMLElement | null>): Ref<boolean> {
	const narrow = ref(false);
	let observer: ResizeObserver | null = null;

	function measure() {
		narrow.value = isNarrowWidth(target.value?.clientWidth ?? 0, remInPixels());
	}

	function observe(element: HTMLElement | null) {
		observer?.disconnect();
		measure();
		if (!element || typeof ResizeObserver === 'undefined') return;
		observer = new ResizeObserver(measure);
		observer.observe(element);
	}

	onMounted(() => observe(target.value));
	watch(target, (element) => observe(element));
	onBeforeUnmount(() => observer?.disconnect());

	return narrow;
}
