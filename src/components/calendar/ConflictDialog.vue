<script lang="ts" setup>
/**
 * La vista comparativa de un evento en conflicto: la versión local y la del
 * servidor, una al lado de la otra, con las dos acciones para resolverlo.
 *
 * Es un diálogo flotante dentro de la ventana —superficie opaca `ui-float`— con
 * el estilo de Once UI de `vue-libvasak`: no dibuja controles propios. No hay
 * diferencia por campo (v1): se muestran las dos versiones legibles —resumen,
 * fechas y ubicación parseados del crudo iCal, o el crudo tal cual como
 * respaldo— y la persona elige con cuál quedarse.
 *
 * ── Qué puede pasar al traer la comparación ───────────────────────────────────
 *
 *  - La copia del servidor **todavía no llegó** (`server_unavailable`): se dice,
 *    y «tomar la del servidor» se apaga —no se puede adoptar lo que no está—;
 *    «mantener la mía» sigue disponible, y se puede cerrar y reintentar luego.
 *  - El cambio local es un **borrado** (`op = 'delete'`): no hay versión local
 *    que mostrar; «la mía» es borrar el evento.
 *  - El id **ya no está en conflicto** (otro lo resolvió, o el almacén lo
 *    sincronizó): se dice, sin acciones.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import {
	ActionButton,
	AlertMessage,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	LoadingState,
} from '@vasakgroup/vue-libvasak';
import { computed, ref, watch } from 'vue';
import type { ConflictChoice, ConflictComparison } from '@/composables/use-calendario';
import { type IcalCard, parseIcalCard } from '@/tools/ical-summary';
import type { CalendarEvent } from '@/tools/mes';

const props = withDefaults(
	defineProps<{
		open: boolean;
		/** El evento en conflicto, del que sale el id con que se trae la comparación. */
		event?: CalendarEvent | null;
		/** Trae la comparación del almacén. `null` si el id ya no está en conflicto. */
		load: (eventUid: string) => Promise<ConflictComparison | null>;
		/** El mensaje de un fallo al resolver, ya traducido, que decide el padre. */
		error?: string;
		/** Mientras la resolución está en curso: desactiva los botones. */
		busy?: boolean;
	}>(),
	{ event: null, error: '', busy: false }
);

const emit = defineEmits<{
	'update:open': [open: boolean];
	/** Resolver el conflicto con la elección de la persona. */
	resolve: [choice: ConflictChoice];
}>();

const { t } = useI18n();

/** La comparación traída, mientras está; `null` si el id ya no está en conflicto. */
const comparison = ref<ConflictComparison | null>(null);
/** Si se está trayendo la comparación. */
const loading = ref(false);
/** Si no se pudo traer la comparación (el servicio caído, un impostor). */
const loadFailed = ref(false);

// Al abrirse sobre un evento, trae su comparación. Cada apertura arranca limpia:
// la de un conflicto anterior no puede quedar a la vista.
watch(
	() => [props.open, props.event?.uid] as const,
	([open]) => {
		if (!open || !props.event) {
			return;
		}
		void fetchComparison(props.event.uid);
	},
	{ immediate: true }
);

async function fetchComparison(eventUid: string) {
	loading.value = true;
	loadFailed.value = false;
	comparison.value = null;
	try {
		comparison.value = await props.load(eventUid);
	} catch (e) {
		console.error('no se pudo traer la comparación del conflicto', e);
		loadFailed.value = true;
	} finally {
		loading.value = false;
	}
}

/** El id ya no está en conflicto: se trajo, pero vino vacío. */
const resolved = computed(() => !loading.value && !loadFailed.value && comparison.value === null);

/** Si el cambio local es un borrado: «la mía» es borrar el evento. */
const localIsDelete = computed(() => comparison.value?.op === 'delete');

/** Si la copia del servidor todavía no llegó. */
const serverUnavailable = computed(() => comparison.value?.server_unavailable ?? false);

/** La versión local, parseada del crudo. `null` si no hay (un borrado). */
const localCard = computed<IcalCard | null>(() => cardOf(comparison.value?.local));
/** La versión del servidor, parseada del crudo. `null` si no llegó. */
const serverCard = computed<IcalCard | null>(() => cardOf(comparison.value?.server));

function cardOf(raw: string | null | undefined): IcalCard | null {
	return raw ? parseIcalCard(raw) : null;
}

/**
 * Los campos legibles de una versión, con su etiqueta traducida y sólo los que
 * tienen algo. Si ninguno tiene —un crudo que no se pudo parsear—, va vacío y la
 * vista cae al crudo tal cual.
 */
function fieldsOf(card: IcalCard): { label: string; value: string }[] {
	return [
		{ label: t('conflicto.campoResumen'), value: card.summary },
		{ label: t('conflicto.campoComienzo'), value: card.start },
		{ label: t('conflicto.campoFin'), value: card.end },
		{ label: t('conflicto.campoUbicacion'), value: card.location },
	].filter((field) => field.value);
}

/** Un crudo se muestra parseado sólo si se le sacó al menos un campo. */
function hasFields(card: IcalCard | null): boolean {
	return !!card && fieldsOf(card).length > 0;
}

function close() {
	emit('update:open', false);
}

function keepLocal() {
	emit('resolve', 'keep_local');
}

function takeServer() {
	emit('resolve', 'take_server');
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent size="lg">
      <DialogHeader closable>
        <DialogTitle>{{ t('conflicto.titulo') }}</DialogTitle>
      </DialogHeader>

      <DialogBody>
        <LoadingState v-if="loading" :label="t('conflicto.cargando')" />

        <!-- No se pudo traer la comparación: el servicio caído, un impostor. Se
             puede cerrar y reintentar. -->
        <AlertMessage
          v-else-if="loadFailed"
          tone="error"
          icon="auto"
          :title="t('conflicto.noSePudoCargar')">
          {{ t('conflicto.reintentarNota') }}
        </AlertMessage>

        <!-- El id ya no está en conflicto: alguien lo resolvió, o se sincronizó. -->
        <AlertMessage
          v-else-if="resolved"
          tone="success"
          icon="auto"
          :title="t('conflicto.yaResuelto')" />

        <div v-else class="flex flex-col gap-4">
          <p class="text-body-s text-tx-muted" role="note">
            {{ t('conflicto.ayuda') }}
          </p>

          <!-- Las dos versiones: una al lado de la otra cuando el diálogo da el
               ancho, apiladas cuando no. El envoltorio es un contenedor. -->
          <div class="@container">
            <div class="grid grid-cols-1 gap-4 @sm:grid-cols-2">
              <!-- La mía. -->
              <section class="flex min-w-0 flex-col gap-2">
                <h3 class="text-body-s font-medium text-tx">{{ t('conflicto.local') }}</h3>
                <p v-if="localIsDelete" class="text-body-s text-tx-muted">
                  {{ t('conflicto.borradoLocal') }}
                </p>
                <dl v-else-if="hasFields(localCard)" class="flex min-w-0 flex-col gap-1">
                  <div
                    v-for="field in fieldsOf(localCard!)"
                    :key="field.label"
                    class="flex min-w-0 flex-col">
                    <dt class="text-body-s text-tx-muted">{{ field.label }}</dt>
                    <dd class="min-w-0 break-words text-body-s text-tx">{{ field.value }}</dd>
                  </div>
                </dl>
                <pre
                  v-else
                  class="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap rounded-corner-m bg-ui-surface p-2 text-body-s text-tx-muted">{{ comparison?.local }}</pre>
              </section>

              <!-- La del servidor. -->
              <section class="flex min-w-0 flex-col gap-2">
                <h3 class="text-body-s font-medium text-tx">{{ t('conflicto.servidor') }}</h3>
                <p v-if="serverUnavailable" class="text-body-s text-tx-muted">
                  {{ t('conflicto.servidorNoDisponible') }}
                </p>
                <dl v-else-if="hasFields(serverCard)" class="flex min-w-0 flex-col gap-1">
                  <div
                    v-for="field in fieldsOf(serverCard!)"
                    :key="field.label"
                    class="flex min-w-0 flex-col">
                    <dt class="text-body-s text-tx-muted">{{ field.label }}</dt>
                    <dd class="min-w-0 break-words text-body-s text-tx">{{ field.value }}</dd>
                  </div>
                </dl>
                <pre
                  v-else
                  class="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap rounded-corner-m bg-ui-surface p-2 text-body-s text-tx-muted">{{ comparison?.server }}</pre>
              </section>
            </div>
          </div>

          <!-- Lo que falló al resolver (del padre), anunciado para el lector de
               pantalla. -->
          <p v-if="error" class="text-body-s text-tx-muted" role="status">
            {{ error }}
          </p>
        </div>
      </DialogBody>

      <DialogFooter>
        <template v-if="comparison">
          <ActionButton
            variant="secondary"
            :label="t('conflicto.mantenerLaMia')"
            :disabled="busy"
            @click="keepLocal" />
          <!-- No se puede adoptar lo que todavía no llegó. -->
          <ActionButton
            variant="primary"
            :label="t('conflicto.tomarLaDelServidor')"
            :disabled="busy || serverUnavailable"
            :loading="busy"
            @click="takeServer" />
        </template>
        <template v-else>
          <ActionButton
            variant="secondary"
            :label="t('conflicto.cerrar')"
            :disabled="busy"
            @click="close" />
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
