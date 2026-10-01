/**
 * Una columna por vez en una ventana angosta, como una aplicación de teléfono.
 *
 * Con la ventana ancha se ven las dos columnas —cuentas y mes— una al lado de
 * la otra, como siempre. Por debajo de 36 rem **de fila** (no de pantalla: la
 * barra puede ir a un costado y comerse 48 px) las dos no entran sin
 * aplastarse: el panel de cuentas quedaba apretado al lado de un mes de siete
 * columnas de 20 px. Ahí el mes ocupa toda la fila y las cuentas pasan a ser
 * una vista propia, con un botón para ir y otro para volver.
 *
 * Lo decide una consulta de contenedor sobre la fila de la ventana
 * (`@container/row` en `WindowAppLayout`), no un punto de corte de pantalla:
 * WebKitGTK no avisa de `resize` ni de `matchMedia`, y la fila sabe cuánto
 * lugar tiene aunque la ventana no lo sepa. Por eso el estado (`Pane`) se lleva
 * siempre, también con la ventana ancha, donde no se nota: si la persona la
 * angosta, ve la columna en la que estaba.
 *
 * Las dos columnas quedan **montadas** siempre; la que no se mira se oculta con
 * CSS. Así lo elegido en el panel —la zona horaria, el menú del selector— no se
 * pierde al ir y volver.
 *
 * 36 rem son 576 px: la ventana de 600 tiene unos 590 de fila y se ve igual que
 * hoy, con las dos columnas. Es el mismo umbral que vasak-contacts, para que
 * las aplicaciones de cuentas cambien de forma al mismo ancho.
 */
export type Pane = 'accounts' | 'month';

/**
 * El umbral, en rem, para lo que lo mide con `ResizeObserver` (la barra, que
 * queda fuera de la fila). Tiene que ser el mismo número que el de las clases
 * de abajo: hay una prueba que lo compara.
 */
export const NARROW_ROW_REM = 36;

/** Con la ventana angosta, la columna que se ve ocupa toda la fila. */
export const PANE_SHOWN =
	'@max-[36rem]/row:w-full @max-[36rem]/row:max-w-none @max-[36rem]/row:flex-1';

/** Con la ventana angosta, la otra no se ve. */
export const PANE_HIDDEN = '@max-[36rem]/row:hidden';

/**
 * Lo que sólo existe con la ventana angosta: los botones de ir y volver, y el
 * mes como agenda (`components/calendar/MonthAgenda.vue`).
 */
export const NARROW_ONLY = '@min-[36rem]/row:hidden';

/**
 * Lo que sólo existe con la ventana ancha: la cuadrícula del mes. Por debajo
 * de 36 rem sus siete columnas miden unos 30 px, y ahí el mes se ve como
 * agenda. Es el complemento exacto de `NARROW_ONLY`: a ningún ancho se ven
 * las dos vistas, ni ninguna.
 */
export const WIDE_ONLY = '@max-[36rem]/row:hidden';

/** Las clases de una columna según cuál se está mirando. */
export function paneClass(pane: Pane, current: Pane): string {
	return pane === current ? PANE_SHOWN : PANE_HIDDEN;
}
