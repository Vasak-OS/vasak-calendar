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
}>();

const emit = defineEmits<(e: 'elegir', zona: string) => void>();

const { t } = useI18n();

/**
 * Un `<select>` del sistema y no una lista propia.
 *
 * Son cientos de zonas: una lista propia necesitaría búsqueda, teclado y
 * desplazamiento virtual para no ser peor que la del sistema, que ya sabe hacer
 * todo eso —incluido escribir las primeras letras para saltar— y además se ve
 * como el resto del escritorio.
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
  <label class="flex items-center gap-1 text-sm">
    <span class="sr-only">{{ t('calendario.zonaEtiqueta') }}</span>
    <select
      class="max-w-56 truncate rounded-corner border border-ui-border-strong bg-transparent px-1 py-0.5 text-sm"
      :value="props.elegida"
      :title="t('calendario.zonaAyuda')"
      @change="emit('elegir', ($event.target as HTMLSelectElement).value)">
      <option value="">
        {{ interpolar(t('calendario.zonaDelSistema'), legible(props.delSistema)) }}
      </option>
      <option v-for="zona in zonas" :key="zona" :value="zona">{{ legible(zona) }}</option>
    </select>
  </label>
</template>
