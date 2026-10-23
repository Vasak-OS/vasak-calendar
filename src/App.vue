<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useConfigStore } from '@vasakgroup/plugin-config-manager';
import { onMounted, onUnmounted, type Ref, ref } from 'vue';
import { guardarTema } from '@/tools/tema-cache';
import CalendarView from '@/views/CalendarView.vue';

let unListenConfig: Ref<UnlistenFn | null> = ref(null);

// La **primera** lectura de la configuración ya no está acá: la hace `main.ts`
// antes de montar. Estando en `onMounted` corría después del primer dibujo, así
// que hasta que resolvía no existían las variables `--use-*` y la ventana se veía
// unos instantes con el tema claro, que es a lo que cae la hoja de estilo cuando
// no hay ninguna. Lo que queda acá es escuchar los cambios de después.
onMounted(async () => {
	// Afina el WebKit de la ventana (menos caché, sin extras de desarrollo) para
	// bajar su consumo de memoria. Sin bloquear el montaje ni romper en el navegador.
	invoke('tune_webview').catch(() => {});

	try {
		const configStore = useConfigStore();

		unListenConfig.value = await listen('config-changed', async () => {
			document.startViewTransition(() => {
				configStore.loadConfig().then(() => guardarTema());
			});
		});
	} catch (error: any) {
		console.error('Error al escuchar los cambios de configuración en App.vue', error);
	}
});

onUnmounted(() => {
	if (unListenConfig.value !== null) {
		unListenConfig.value();
	}
});
</script>

<template>
  <!-- La vista es dueña de la ventana entera, layout incluido.
       Así el mes y los botones de la barra salen del mismo `useCalendario()`
       que la cuadrícula, sin duplicar el estado ni teletransportar nada. -->
  <CalendarView />
</template>
