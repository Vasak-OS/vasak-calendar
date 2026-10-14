<script lang="ts" setup>
/**
 * El indicador de sincronización de un objeto del almacén: «sin sincronizar»
 * cuando el cambio local todavía no llegó al servidor, «en conflicto» cuando
 * chocó con él.
 *
 * Es el `Badge` de `vue-libvasak` —estilo Once UI, colores del esquema por el
 * tono—, en un solo lugar porque lo muestran la cuadrícula del mes, la agenda,
 * las columnas y la lista de tareas: una copia por vista terminaría diciendo
 * cada una una cosa. Mira sólo el `sync_state` (ver `tools/sync-state.ts`), así
 * que sirve igual para un evento y para una tarea. Un objeto al día (`synced`, o
 * sin estado) no dibuja nada.
 *
 * En la celda apretada del mes va `compact`: sólo el punto del tono, con el
 * texto en el globo del sistema; en una fila, con su texto al lado.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { Badge } from '@vasakgroup/vue-libvasak';
import { computed } from 'vue';
import { isConflict, isPending, type SyncStatus } from '@/tools/sync-state';

const props = withDefaults(
	defineProps<{
		/** El objeto del que se mira el estado: un evento o una tarea. */
		event: SyncStatus;
		/** Sólo el punto, sin texto, para donde no hay lugar (la celda del mes). */
		compact?: boolean;
	}>(),
	{ compact: false }
);

const { t } = useI18n();

/** El tono y el texto según el estado, o `null` si no hay nada que marcar. */
const mark = computed(() => {
	if (isConflict(props.event)) {
		return { tone: 'error' as const, label: t('sincronizacion.conflicto') };
	}
	if (isPending(props.event)) {
		return { tone: 'warning' as const, label: t('sincronizacion.pendiente') };
	}
	return null;
});
</script>

<template>
  <!-- El `data-testid` va en un envoltorio y no en el `Badge`: con las plantillas
       estrictas, un atributo que el componente no declara no compila. -->
  <span v-if="mark" class="flex min-w-0 shrink-0" data-testid="sync-badge">
    <Badge
      :tone="mark.tone"
      dot
      size="sm"
      :label="compact ? undefined : mark.label"
      :title="mark.label" />
  </span>
</template>
