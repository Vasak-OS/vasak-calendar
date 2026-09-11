<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { computed } from 'vue';
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
 * Un `<select>` del sistema y no una lista propia.
 *
 * Son cientos de zonas: una lista propia necesitaría búsqueda, teclado y
 * desplazamiento virtual para no ser peor que la del sistema, que ya sabe hacer
 * todo eso —incluido escribir las primeras letras para saltar—.
 *
 * Lo que sí hay que hacer es **vestirlo**: sin colores propios el motor lo pinta
 * con los suyos, y en una ventana oscura quedaba un rectángulo blanco. Las
 * opciones desplegadas las dibuja el sistema y no se pueden pintar del todo, así
 * que se les da fondo y texto explícitos para que al menos no queden ilegibles.
 *
 * La del sistema va primero y aparte, porque es la que casi todo el mundo quiere
 * y la que hay que poder recuperar de un golpe después de probar otra.
 */
const zonas = computed(() => zonasConocidas().filter((z) => z !== props.delSistema));

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
    <select
      class="w-full truncate rounded-corner border border-ui-border-strong bg-ui-surface px-2 py-1 text-sm text-tx-main"
      :value="props.elegida"
      :title="t('calendario.zonaAyuda')"
      @change="emit('elegir', ($event.target as HTMLSelectElement).value)">
      <option class="bg-ui-bg text-tx-main" value="">
        {{ t('calendario.zonaDelSistema') }}
      </option>
      <option v-for="zona in zonas" :key="zona" class="bg-ui-bg text-tx-main" :value="zona">
        {{ legible(zona) }}
      </option>
    </select>

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
