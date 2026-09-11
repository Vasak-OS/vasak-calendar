<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { computed } from 'vue';
import SelectorBuscable from '@/components/comunes/SelectorBuscable.vue';
import type { Opcion } from '@/tools/buscar';
import { interpolar } from '@/tools/interpolar';
import { zonasConocidas } from '@/tools/zona';

const props = defineProps<{
	/** La elegida, o vacío si se sigue a la del sistema. */
	elegida: string;
	/** En cuál está el sistema, para nombrarla en la opción de arriba. */
	delSistema: string;
	/** La que se está usando, que es la elegida o la del sistema. */
	enUso: string;
	/** Si lo que se está mirando no es la hora de acá. */
	ajena: boolean;
}>();

const emit = defineEmits<(e: 'elegir', zona: string) => void>();

const { t } = useI18n();

/**
 * Las opciones, con la del sistema primero.
 *
 * Primero y aparte porque es la que casi todo el mundo quiere, y la que hay que
 * poder recuperar de un golpe después de probar otra. Su valor es la cadena
 * vacía, que es como se dice «seguí al sistema» en el resto del código.
 *
 * **La ciudad adelante y la región al costado**, y no el nombre entero de IANA:
 * en «Africa/Abidjan — Abidjan» la segunda columna repetía la primera y no
 * agregaba nada, y en un panel angosto el nombre largo quedaba cortado justo en
 * la parte que dice cuál es. La ciudad es lo que la gente busca; la región es lo
 * que desambigua dos ciudades con el mismo nombre.
 *
 * Buscar sigue encontrando por el nombre entero: el `valor` de la opción es el
 * de IANA sin tocar, y `buscarOpciones` mira los tres campos.
 */
const zonas = computed<Opcion[]>(() => [
	{
		valor: '',
		etiqueta: t('calendario.zonaDelSistema'),
		detalle: ciudad(props.delSistema),
	},
	...zonasConocidas()
		.filter((z) => z !== props.delSistema)
		.map((z) => ({ valor: z, etiqueta: ciudad(z), detalle: region(z) })),
]);

/** La última parte de un nombre de IANA, que es la ciudad. */
function ciudad(zona: string): string {
	return legible(zona.split('/').pop() ?? zona);
}

/** Lo que va antes de la ciudad: `America/Argentina` en Buenos Aires. */
function region(zona: string): string {
	return legible(zona.split('/').slice(0, -1).join('/'));
}

/**
 * Los nombres se muestran como los escribe IANA: `America/Argentina/Buenos_Aires`.
 *
 * Traducirlos no se puede —no hay catálogo de nombres de zona en el sistema— y
 * maquillarlos sería peor: quien busca su zona busca exactamente ese texto,
 * porque es el que ve en todos lados. Lo único que se toca son los guiones bajos,
 * que se leen mal y no cambian de qué zona se habla.
 */
function legible(zona: string): string {
	return zona.replace(/_/g, ' ');
}
</script>

<template>
  <section class="flex flex-col gap-1">
    <h2 class="font-medium text-tx-muted text-xs uppercase">
      {{ t('calendario.zonaEtiqueta') }}
    </h2>
    <!-- Dibujado por la aplicación y no por el sistema: ver `SelectorBuscable`.
         Hacia arriba porque esto vive al pie del panel, y hacia abajo el menú se
         saldría de la ventana. -->
    <SelectorBuscable
      :model-value="props.elegida"
      :opciones="zonas"
      :etiqueta="t('calendario.zonaEtiqueta')"
      :placeholder-busqueda="t('calendario.zonaBuscar')"
      :texto-sin-resultados="t('calendario.zonaSinResultados')"
      hacia-arriba
      @update:model-value="emit('elegir', $event)" />

    <!-- El nombre de la zona va **abajo y no adentro** del desplegable.
         «La del sistema (America/Argentina/Buenos Aires)» no entra en el ancho
         de esta barra y quedaba cortado a la mitad, justo en la parte que dice
         cuál es. Acá abajo entra entero y puede partirse en dos renglones.

         Y que la agenda no esté en la hora de acá se dice, no se deduce: quien
         fijó una zona para viajar se olvida, y una agenda que muestra horas de
         otro país sin avisar se lee mal sin que nada lo delate. -->
    <p
      class="break-words text-xs"
      :class="props.ajena ? 'text-status-warning' : 'text-tx-muted'"
      :role="props.ajena ? 'status' : undefined">
      {{ props.ajena ? interpolar(t('calendario.viendoEn'), legible(props.enUso)) : legible(props.enUso) }}
    </p>
  </section>
</template>
