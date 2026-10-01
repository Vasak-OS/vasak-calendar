<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import {
	ActionButton,
	AlertMessage,
	EmptyState,
	Panel,
	SectionHeading,
	StatusDot,
} from '@vasakgroup/vue-libvasak';
import TimeZonePicker from '@/components/calendar/TimeZonePicker.vue';
import type { Calendario, Cuenta } from '@/composables/use-calendario';
import { NARROW_ONLY } from '@/tools/narrow-layout';

defineProps<{
	accounts: Cuenta[];
	calendars: Calendario[];
	notices: string[];
	zone: string;
	chosenZone: string;
	systemZone: string;
	foreignZone: boolean;
}>();

const emit = defineEmits<{
	chooseZone: [zone: string];
	/** Volver al mes, con la ventana angosta. */
	forward: [];
}>();

const { t } = useI18n();
</script>

<template>
  <Panel as="aside" padding="none" class="w-56 max-w-[40%] shrink-0 gap-4 p-3">
    <!-- **El panel no desplaza; desplaza lo de adentro.** Con `overflow-y-auto`
         acá, el menú del selector de zona quedaba recortado por el borde del
         panel: un menú que se abre y se ve por la mitad. Además el selector queda
         clavado abajo en vez de irse con el desplazamiento, que es donde se lo
         busca.

         El ancho es el de siempre (`w-56`) mientras haya lugar, pero nunca más
         del 40 % de la fila: con el ancho fijo solo, el panel se quedaba con sus
         224 px y la cuadrícula del mes desaparecía entera por debajo de los
         450 px de ventana. Desde unos 560 px de fila, el panel mide lo mismo que
         antes.

         Por debajo de 36 rem de fila el panel deja de ir al costado: pasa a
         ser una vista propia que ocupa toda la fila, y este botón lleva de
         vuelta al mes (ver `tools/narrow-layout.ts`). Con la ventana ancha no
         existe. -->
    <div class="flex shrink-0 justify-end" :class="NARROW_ONLY" data-nav="accounts">
      <ActionButton
        variant="ghost"
        size="sm"
        icon="go-next"
        icon-type="symbol"
        icon-right
        :label="t('nav.month')"
        @click="emit('forward')" />
    </div>
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <!-- Sin ninguna cuenta, lo que hace falta es decir **qué hacer**. Una lista
           vacía sin explicación se lee como una aplicación rota. -->
      <EmptyState
        v-if="accounts.length === 0"
        size="sm"
        icon=""
        :title="t('cuentas.sinCuentasTitulo')"
        :note="t('cuentas.sinCuentasDescripcion')" />

      <section v-else class="flex flex-col gap-2">
        <SectionHeading as="h2" :title="t('cuentas.titulo')" />
        <ul class="flex flex-col gap-1">
          <li v-for="account in accounts" :key="account.id" class="flex min-w-0 flex-col">
            <span class="truncate text-sm" :title="account.nombre">{{ account.nombre }}</span>
            <!-- Una cuenta que hay que reconectar se muestra igual, con el aviso
                 al lado: sacarla de la lista se ve como una cuenta borrada, y la
                 persona no se enteraría de que le falta hacer algo.

                 El punto del tono y el texto atenuado, y no el texto en
                 amarillo: el color de aviso del esquema no llega a 4,5:1 como
                 color de texto sobre el panel en claro. -->
            <span
              v-if="account.necesita_reconectarse"
              class="flex items-start gap-1.5 text-tx-muted text-xs"
              data-testid="needs-reconnect">
              <StatusDot tone="warning" class="mt-1" />
              <span class="min-w-0 break-words">{{ t('cuentas.necesitaReconectarse') }}</span>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="calendars.length > 0" class="flex flex-col gap-2">
        <SectionHeading as="h2" :title="t('cuentas.calendarios')" />
        <ul class="flex flex-col gap-1">
          <li
            v-for="calendar in calendars"
            :key="calendar.url"
            class="flex min-w-0 items-center gap-2">
            <!-- El color de cada calendario es **dato del servidor**, no del
                 esquema: va como `color` del punto, que lo pone por `style`
                 (la excepción de la guardia). Sin color, el acento. -->
            <StatusDot
              size="md"
              tone="accent"
              :color="calendar.color ?? undefined" />
            <span class="truncate text-sm" :title="calendar.nombre">{{ calendar.nombre }}</span>
          </li>
        </ul>
      </section>

      <!-- Lo que no se pudo leer va a la vista y no a la consola.
           Un mes vacío y un mes que falló se ven exactamente igual, y la
           diferencia importa: en uno la persona está libre y en el otro no tiene
           idea de qué tiene.

           En el aviso del sistema, como en los contactos: `warning` y no
           `error` —el calendario funciona, sólo que incompleto—, y con eso el
           rol sigue siendo `status`: espera turno en vez de interrumpir. -->
      <AlertMessage
        v-if="notices.length > 0"
        tone="warning"
        icon="dialog-warning"
        :title="t('cuentas.noSePudoLeerTodo')">
        <ul class="flex flex-col gap-1 text-xs">
          <li v-for="notice in notices" :key="notice" class="break-words">{{ notice }}</li>
        </ul>
      </AlertMessage>
    </div>

    <TimeZonePicker
      :chosen="chosenZone"
      :system-zone="systemZone"
      :active-zone="zone"
      :foreign="foreignZone"
      @choose="emit('chooseZone', $event)" />
  </Panel>
</template>
