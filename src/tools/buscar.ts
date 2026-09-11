/**
 * Búsqueda ordenada para una lista larga.
 *
 * **Copiado de `vasak-installer`, a propósito y sin cambios de lógica.** Ahí
 * resuelve el mismo problema —elegir una zona horaria entre más de
 * cuatrocientas— y ya tiene sus pruebas; rehacerlo distinto acá sería tener dos
 * comportamientos para la misma pantalla en dos partes del sistema. El día que
 * haya un paquete común de interfaz, esto va ahí y se borra de los dos.
 *
 * La lista se recorta a las primeras coincidencias para que escribir no
 * recalcule cientos de nodos por tecla. Con un filtro que sólo pregunta
 * «¿contiene el texto?» y devuelve en orden alfabético, ese recorte deja afuera
 * justo lo que se estaba buscando.
 *
 * El caso que lo hizo evidente en el instalador: alguien busca el teclado
 * latinoamericano y escribe `la`. `la-latin1` es la respuesta, pero también
 * contienen «la» `be-latin1`, `br-latin1-abnt2`, `cz-lat2`, `de-latin1`,
 * `fr-latin1`… y todos van antes por alfabeto. La entrada correcta aparecía más
 * de treinta lugares abajo. Con las zonas pasa igual: escribir `buenos` tiene
 * que traer Buenos Aires primero y no `America/Argentina/…` de todo el país.
 *
 * La solución no es agrandar el recorte —eso devuelve el problema de
 * rendimiento— sino ordenar por qué tan bien coincide cada una.
 */

export interface Opcion {
	valor: string;
	etiqueta: string;
	/** Segunda línea, para desambiguar («Argentina» debajo de «Buenos Aires»). */
	detalle?: string;
}

/**
 * Qué tan bien coincide una opción con lo que se escribió. Menor es mejor.
 *
 * Los niveles están separados por decenas para que el desempate alfabético de
 * adentro de cada nivel nunca pueda cruzar de nivel.
 */
enum Rango {
	/** Es exactamente lo que se escribió. */
	Exacto = 0,
	/** El identificador empieza así: `la` → `la-latin1`. */
	PrefijoValor = 10,
	/** El nombre visible empieza así: `bue` → `Buenos Aires`. */
	PrefijoEtiqueta = 20,
	/** Empieza así un tramo interno: `argentina` → `America/Argentina/…`. */
	PrefijoDeTramo = 30,
	/** Aparece en algún lado. */
	Contiene = 40,
	/** No coincide. */
	Ninguno = 100,
}

/**
 * Los separadores que parten un identificador en tramos.
 *
 * `America/Argentina/Buenos_Aires`, `de-latin1`, `es_AR`: los tres nombran cosas
 * distintas en cada tramo, y buscar por el tramo del medio es normal —nadie
 * escribe «america/» para llegar a Argentina.
 */
const SEPARADORES = /[/\-_.]/;

function rangoDe(texto: string, campo: string | undefined): Rango {
	if (!campo) return Rango.Ninguno;
	const c = campo.toLowerCase();
	if (c === texto) return Rango.Exacto;
	if (c.startsWith(texto)) return Rango.PrefijoValor;
	if (c.split(SEPARADORES).some((tramo) => tramo.startsWith(texto))) {
		return Rango.PrefijoDeTramo;
	}
	if (c.includes(texto)) return Rango.Contiene;
	return Rango.Ninguno;
}

/**
 * Filtra y ordena las opciones según el texto escrito.
 *
 * Con el texto vacío devuelve la lista tal como vino: sin nada escrito no hay
 * ninguna razón para reordenar, y hacerlo movería las entradas bajo el cursor
 * de alguien que estaba mirando.
 *
 * El orden dentro de cada nivel de coincidencia es el de entrada, que acá es
 * alfabético porque así las devuelve el motor.
 */
export function buscarOpciones(opciones: Opcion[], texto: string): Opcion[] {
	const buscado = texto.trim().toLowerCase();
	if (!buscado) return opciones;

	const puntuadas: { opcion: Opcion; rango: number; orden: number }[] = [];

	for (let i = 0; i < opciones.length; i++) {
		const opcion = opciones[i];

		// El identificador manda sobre el nombre visible: es lo que la gente
		// escribe cuando lo conoce (`la-latin1`, `es_AR`), y es corto, así que un
		// prefijo suyo es una señal mucho más fuerte que un prefijo de un nombre
		// largo.
		const porValor = rangoDe(buscado, opcion.valor);
		// El nombre visible arranca un nivel más abajo para que un prefijo del
		// identificador le gane a un prefijo del nombre.
		const porEtiqueta = rangoDe(buscado, opcion.etiqueta);
		const porEtiquetaAjustado =
			porEtiqueta === Rango.PrefijoValor ? Rango.PrefijoEtiqueta : porEtiqueta;
		// El detalle es lo más débil: es la columna de desambiguación, y una
		// coincidencia ahí casi nunca es lo que se estaba buscando.
		const porDetalle = rangoDe(buscado, opcion.detalle);
		const porDetalleAjustado = porDetalle === Rango.Ninguno ? Rango.Ninguno : Rango.Contiene;

		const rango = Math.min(porValor, porEtiquetaAjustado, porDetalleAjustado);
		if (rango === Rango.Ninguno) continue;

		puntuadas.push({ opcion, rango, orden: i });
	}

	// `sort` de JavaScript es estable desde ES2019, pero el desempate va escrito
	// igual: sin él, dos opciones del mismo nivel dependen de una garantía del
	// motor para no bailar entre búsquedas.
	puntuadas.sort((a, b) => a.rango - b.rango || a.orden - b.orden);

	return puntuadas.map((p) => p.opcion);
}
