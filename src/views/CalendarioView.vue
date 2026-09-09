<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { computed, onMounted } from 'vue';
import CuentasComponent from '@/components/calendario/CuentasComponent.vue';
import MesComponent from '@/components/calendario/MesComponent.vue';
import { useCalendario } from '@/composables/use-calendario';
import { useReactiveIcons } from '@/composables/useReactiveIcon';

const { t, locale } = useI18n();
const {
	mes,
	dias,
	cuentas,
	calendarios,
	cargando,
	avisos,
	eventosDe,
	cargar,
	mesAnterior,
	mesSiguiente,
	irAHoy,
} = useCalendario();

const { anterior, siguiente } = useReactiveIcons({
	anterior: 'go-previous',
	siguiente: 'go-next',
});

/** «septiembre de 2026», en el idioma de la sesión y sin traducirlo a mano. */
const titulo = computed(() =>
	new Intl.DateTimeFormat(locale.value, { month: 'long', year: 'numeric' }).format(mes.value)
);

onMounted(cargar);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <header class="flex items-center gap-2 border-ui-border border-b px-3 py-2">
      <button
        type="button"
        class="rounded-corner p-1 hover:bg-ui-surface"
        :aria-label="t('calendario.mesAnterior')"
        @click="mesAnterior()">
        <img :src="anterior" class="h-5 w-5" alt="" />
      </button>
      <button
        type="button"
        class="rounded-corner p-1 hover:bg-ui-surface"
        :aria-label="t('calendario.mesSiguiente')"
        @click="mesSiguiente()">
        <img :src="siguiente" class="h-5 w-5" alt="" />
      </button>
      <!-- `aria-live` para que al cambiar de mes se anuncie: el título es lo
           único que dice dónde quedó la cuadrícula, y quien no la ve no tiene
           otra pista. -->
      <h1 class="font-title text-lg capitalize" aria-live="polite">{{ titulo }}</h1>
      <button
        type="button"
        class="rounded-corner border border-ui-border-strong px-2 py-0.5 text-sm hover:bg-ui-surface"
        @click="irAHoy()">
        {{ t('calendario.hoy') }}
      </button>

      <span class="flex-1"></span>

      <!-- El estado de carga se dice, no se insinúa con un icono girando: sin
           esto, un servidor lento y un mes vacío se ven igual. -->
      <span v-if="cargando" class="text-tx-muted text-xs" role="status">
        {{ t('calendario.cargando') }}
      </span>
      <button
        v-else
        type="button"
        class="rounded-corner px-2 py-0.5 text-sm text-tx-muted hover:bg-ui-surface"
        @click="cargar()">
        {{ t('calendario.actualizar') }}
      </button>
    </header>

    <div class="flex min-h-0 flex-1">
      <CuentasComponent :cuentas="cuentas" :calendarios="calendarios" :avisos="avisos" />
      <MesComponent :dias="dias" :eventos-de="eventosDe" />
    </div>
  </div>
</template>
