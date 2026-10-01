<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import {
	type OpcionDeBusqueda,
	SearchSelect,
	SectionHeading,
	StatusDot,
} from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import { interpolar } from '@/tools/interpolar';
import { zonasConocidas } from '@/tools/zona';

const props = defineProps<{
	/** La elegida, o vacío si se sigue a la del sistema. */
	chosen: string;
	/** En cuál está el sistema, para nombrarla en la opción de arriba. */
	systemZone: string;
	/** La que se está usando, que es la elegida o la del sistema. */
	activeZone: string;
	/** Si lo que se está mirando no es la hora de acá. */
	foreign: boolean;
}>();

const emit = defineEmits<(e: 'choose', zone: string) => void>();

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
const zoneOptions = computed<OpcionDeBusqueda[]>(() => [
	{
		valor: '',
		etiqueta: t('calendario.zonaDelSistema'),
		detalle: cityOf(props.systemZone),
	},
	...zonasConocidas()
		.filter((z) => z !== props.systemZone)
		.map((z) => ({ valor: z, etiqueta: cityOf(z), detalle: regionOf(z) })),
]);

/** La última parte de un nombre de IANA, que es la ciudad. */
function cityOf(zone: string): string {
	return readable(zone.split('/').pop() ?? zone);
}

/** Lo que va antes de la ciudad: `America/Argentina` en Buenos Aires. */
function regionOf(zone: string): string {
	return readable(zone.split('/').slice(0, -1).join('/'));
}

/**
 * Los nombres se muestran como los escribe IANA: `America/Argentina/Buenos_Aires`.
 *
 * Traducirlos no se puede —no hay catálogo de nombres de zona en el sistema— y
 * maquillarlos sería peor: quien busca su zona busca exactamente ese texto,
 * porque es el que ve en todos lados. Lo único que se toca son los guiones bajos,
 * que se leen mal y no cambian de qué zona se habla.
 */
function readable(zone: string): string {
	return zone.replace(/_/g, ' ');
}
</script>

<template>
  <section class="flex flex-col gap-1">
    <SectionHeading as="h2" :title="t('calendario.zonaEtiqueta')" />
    <!-- Dibujado por la aplicación y no por el sistema: ver `SearchSelect` de la librería.
         Hacia arriba porque esto vive al pie del panel, y hacia abajo el menú se
         saldría de la ventana. -->
    <SearchSelect
      :model-value="props.chosen"
      :options="zoneOptions"
      :label="t('calendario.zonaEtiqueta')"
      :search-placeholder="t('calendario.zonaBuscar')"
      :empty-text="t('calendario.zonaSinResultados')"
      up
      @update:model-value="emit('choose', $event)" />

    <!-- El nombre de la zona va **abajo y no adentro** del desplegable.
         «La del sistema (America/Argentina/Buenos Aires)» no entra en el ancho
         de esta barra y quedaba cortado a la mitad, justo en la parte que dice
         cuál es. Acá abajo entra entero y puede partirse en dos renglones.

         Y que la agenda no esté en la hora de acá se dice, no se deduce: quien
         fijó una zona para viajar se olvida, y una agenda que muestra horas de
         otro país sin avisar se lee mal sin que nada lo delate.

         El aviso lleva el punto del tono y el texto en el color de siempre: el
         amarillo del esquema como color de **texto** no llega a 4,5:1 sobre el
         panel en claro, y lo que importa es que se lea. -->
    <p
      class="flex items-start gap-1.5 break-words text-xs"
      :class="props.foreign ? 'text-tx-main' : 'text-tx-muted'"
      :role="props.foreign ? 'status' : undefined">
      <StatusDot v-if="props.foreign" tone="warning" class="mt-1" />
      <span class="min-w-0">{{ props.foreign ? interpolar(t('calendario.viendoEn'), readable(props.activeZone)) : readable(props.activeZone) }}</span>
    </p>
  </section>
</template>
