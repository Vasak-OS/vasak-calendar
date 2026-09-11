<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import ZonaComponent from '@/components/calendario/ZonaComponent.vue';
import type { Calendario, Cuenta } from '@/composables/use-calendario';

defineProps<{
	cuentas: Cuenta[];
	calendarios: Calendario[];
	avisos: string[];
	zona: string;
	zonaElegida: string;
	zonaDelSistema: string;
	zonaAjena: boolean;
}>();

const emit = defineEmits<(e: 'elegirZona', zona: string) => void>();

const { t } = useI18n();
</script>

<template>
  <!-- **El panel no desplaza; desplaza lo de adentro.** Con `overflow-y-auto`
       acá, el menú del selector de zona quedaba recortado por el borde del
       panel: un menú que se abre y se ve por la mitad. Además el selector queda
       clavado abajo en vez de irse con el desplazamiento, que es donde se lo
       busca. -->
  <aside class="flex w-56 shrink-0 flex-col gap-4 border-ui-border border-r p-3">
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
    <!-- Sin ninguna cuenta, lo que hace falta es decir **qué hacer**. Una lista
         vacía sin explicación se lee como una aplicación rota. -->
    <div v-if="cuentas.length === 0" class="flex flex-col gap-1">
      <p class="font-medium text-sm">{{ t('cuentas.sinCuentasTitulo') }}</p>
      <p class="text-tx-muted text-xs">{{ t('cuentas.sinCuentasDescripcion') }}</p>
    </div>

    <section v-else class="flex flex-col gap-2">
      <h2 class="font-medium text-tx-muted text-xs uppercase">{{ t('cuentas.titulo') }}</h2>
      <ul class="flex flex-col gap-1">
        <li v-for="cuenta in cuentas" :key="cuenta.id" class="flex flex-col">
          <span class="truncate text-sm" :title="cuenta.nombre">{{ cuenta.nombre }}</span>
          <!-- Una cuenta que hay que reconectar se muestra igual, con el aviso
               al lado: sacarla de la lista se ve como una cuenta borrada, y la
               persona no se enteraría de que le falta hacer algo. -->
          <span
            v-if="cuenta.necesita_reconectarse"
            class="text-status-warning text-xs">
            {{ t('cuentas.necesitaReconectarse') }}
          </span>
        </li>
      </ul>
    </section>

    <section v-if="calendarios.length > 0" class="flex flex-col gap-2">
      <h2 class="font-medium text-tx-muted text-xs uppercase">{{ t('cuentas.calendarios') }}</h2>
      <ul class="flex flex-col gap-1">
        <li
          v-for="calendario in calendarios"
          :key="calendario.url"
          class="flex items-center gap-2">
          <span
            class="h-3 w-3 shrink-0 rounded-full"
            :style="{ backgroundColor: calendario.color ?? 'var(--color-primary)' }"
            aria-hidden="true"></span>
          <span class="truncate text-sm" :title="calendario.nombre">{{ calendario.nombre }}</span>
        </li>
      </ul>
    </section>

    <!-- Lo que no se pudo leer va a la vista y no a la consola.
         Un mes vacío y un mes que falló se ven exactamente igual, y la
         diferencia importa: en uno la persona está libre y en el otro no tiene
         idea de qué tiene. -->
    <section v-if="avisos.length > 0" class="flex flex-col gap-1" role="status">
      <h2 class="font-medium text-status-warning text-xs uppercase">
        {{ t('cuentas.noSePudoLeerTodo') }}
      </h2>
      <ul class="flex flex-col gap-1">
        <li v-for="aviso in avisos" :key="aviso" class="text-tx-muted text-xs">{{ aviso }}</li>
      </ul>
      </section>
    </div>

    <ZonaComponent
      :elegida="zonaElegida"
      :del-sistema="zonaDelSistema"
      :en-uso="zona"
      :ajena="zonaAjena"
      @elegir="emit('elegirZona', $event)" />
  </aside>
</template>
