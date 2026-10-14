<script lang="ts" setup>
/**
 * El formulario de crear, editar y borrar un evento.
 *
 * Es un diálogo flotante dentro de la ventana —superficie opaca `ui-float`, que
 * pone `DialogContent`—, con el estilo de Once UI que traen los componentes de
 * `vue-libvasak`: no dibuja controles propios. La lógica de armar el parche y de
 * validar vive en `tools/event-form.ts`, probada aparte; acá queda sólo juntar
 * lo que escribe la persona y mostrar lo que falta.
 *
 * ── Editar está en pausa hasta que el almacén dé el ETag ──────────────────────
 *
 * Editar un evento exige su ETag como `if_match` (decisión 3: edición
 * conservadora con precondición), y hoy ningún DTO de lectura del almacén lo
 * trae. Un evento recién creado tampoco lo tiene hasta la primera vuelta. Así
 * que mientras el evento no tenga ETag, «Guardar» queda deshabilitado y el
 * evento se muestra como **pendiente** (punto 6 de la tarea): se puede ver y
 * borrar, no editar. En cuanto el servicio exponga el ETag por fila, se
 * enciende solo.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import {
	ActionButton,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	FormGroup,
	SelectField,
	SwitchRow,
	TextArea,
	TextInput,
} from '@vasakgroup/vue-libvasak';
import { computed, reactive, ref, watch } from 'vue';
import type { Calendario } from '@/composables/use-calendario';
import { buildCreate, type EventFormState } from '@/tools/event-form';
import { isoToDatePicker, isoToDateTimePicker } from '@/tools/ical-date';
import type { CalendarEvent } from '@/tools/mes';

const props = withDefaults(
	defineProps<{
		open: boolean;
		mode: 'create' | 'edit';
		/** Los calendarios donde se puede escribir. */
		calendars: Calendario[];
		/** La zona de la agenda, con la que se arman las fechas. */
		zone: string;
		/** El evento que se está editando o borrando, en modo `edit`. */
		event?: CalendarEvent | null;
		/** El día que la vista tiene como foco (`AAAA-MM-DD`), para crear ahí. */
		defaultDay?: string;
		/** El mensaje de un fallo al escribir, ya traducido, que decide el padre. */
		error?: string;
		/** Mientras la escritura está en curso: desactiva los botones. */
		busy?: boolean;
	}>(),
	{ event: null, defaultDay: '', error: '', busy: false }
);

const emit = defineEmits<{
	'update:open': [open: boolean];
	/** Crear: el parche armado y a dónde mandarlo. */
	submit: [value: { accountId: string; calendarId: string; payload: Record<string, unknown> }];
	/** Borrar el evento que se está viendo. */
	'delete-event': [event: CalendarEvent];
}>();

const { t } = useI18n();

/** Lo que junta el formulario. Reactivo para que los campos lo escriban. */
const form = reactive<EventFormState>({
	summary: '',
	calendar: '',
	allDay: false,
	start: '',
	end: '',
	location: '',
	description: '',
});

/** Lo que falta, como clave de i18n. Se limpia al tocar cualquier cosa. */
const localError = ref('');

/** Si está pidiendo confirmación para borrar. */
const confirmingDelete = ref(false);

/** Las opciones del desplegable de calendarios: su nombre, su id global. */
const calendarOptions = computed(() =>
	props.calendars.map((c) => ({ label: c.nombre, value: c.url }))
);

/**
 * Editar exige el ETag del evento, que hoy el almacén no entrega: mientras no
 * esté, «Guardar» queda apagado y el evento se ve como pendiente (punto 6).
 */
const canSave = computed(() => props.mode === 'create' || hasEtag(props.event));

/** Si un evento ya tiene ETag, y entonces se puede editar. */
function hasEtag(event: CalendarEvent | null | undefined): boolean {
	return !!event?.etag;
}

/** El título del diálogo según para qué se abrió. */
const title = computed(() =>
	props.mode === 'create' ? t('editor.tituloCrear') : t('editor.tituloEditar')
);

// Al abrirse, arranca el formulario: en blanco para crear (en el día del foco),
// o con lo que trae el evento para ver/editar.
watch(
	() => [props.open, props.event, props.mode] as const,
	([open]) => {
		if (!open) {
			return;
		}
		localError.value = '';
		confirmingDelete.value = false;
		if (props.mode === 'edit' && props.event) {
			fillFrom(props.event);
		} else {
			fillBlank();
		}
	},
	{ immediate: true }
);

/** Arranca el formulario vacío, con un hueco de una hora en el día del foco. */
function fillBlank() {
	const day = props.defaultDay || today();
	form.summary = '';
	form.calendar = props.calendars[0]?.url ?? '';
	form.allDay = false;
	form.start = `${day}T09:00`;
	form.end = `${day}T10:00`;
	form.location = '';
	form.description = '';
}

/**
 * Carga lo que se sabe del evento. El título, las fechas y todo-el-día salen de
 * la vez que se está mirando; la ubicación y la descripción no viajan con la
 * ocurrencia (harían falta de `GetEvent`), así que quedan en blanco: por eso, y
 * porque falta el ETag, editar está en pausa.
 */
function fillFrom(event: CalendarEvent) {
	form.summary = event.title;
	form.calendar = event.calendar;
	form.allDay = event.all_day;
	if (event.all_day) {
		form.start = isoToDatePicker(event.start, true, props.zone);
		form.end = isoToDatePicker(event.end, true, props.zone);
	} else {
		form.start = isoToDateTimePicker(event.start, props.zone);
		form.end = isoToDateTimePicker(event.end, props.zone);
	}
	form.location = '';
	form.description = '';
}

/** Hoy, `AAAA-MM-DD`, para abrir el formulario cuando no hay día de foco. */
function today(): string {
	return isoToDatePicker(new Date().toISOString(), false, props.zone);
}

/**
 * Cambiar entre todo-el-día y con hora: recorta o completa el valor del campo
 * para que no quede a medio formato cuando cambia el tipo de `<input>`.
 */
watch(
	() => form.allDay,
	(allDay, antes) => {
		if (allDay === antes) {
			return;
		}
		form.start = convertValue(form.start, allDay);
		form.end = convertValue(form.end, allDay);
	}
);

/** `AAAA-MM-DDTHH:MM` ⇄ `AAAA-MM-DD` según si pasa a todo-el-día. */
function convertValue(value: string, toAllDay: boolean): string {
	const day = value.slice(0, 10);
	if (toAllDay) {
		return day;
	}
	return value.includes('T') ? value : `${day}T09:00`;
}

function close() {
	emit('update:open', false);
}

/** Valida y, si está bien, emite el parche para crear. */
function onSave() {
	localError.value = '';
	const result = buildCreate(form, props.zone);
	if (!result.ok) {
		localError.value = t(result.error);
		return;
	}
	emit('submit', {
		accountId: result.accountId,
		calendarId: result.calendarId,
		payload: result.patch,
	});
}

function onDelete() {
	if (props.event) {
		emit('delete-event', props.event);
	}
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent size="lg">
      <DialogHeader closable>
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>

      <DialogBody>
        <div class="flex flex-col gap-4">
          <FormGroup :label="t('editor.titulo')" v-slot="{ id }">
            <TextInput
              :id="id"
              v-model="form.summary"
              :placeholder="t('editor.tituloPlaceholder')"
              :disabled="busy" />
          </FormGroup>

          <FormGroup :label="t('editor.calendario')" v-slot="{ id }">
            <SelectField
              :id="id"
              v-model="form.calendar"
              :options="calendarOptions"
              :disabled="busy || mode === 'edit'" />
          </FormGroup>

          <SwitchRow
            v-model="form.allDay"
            :label="t('editor.todoElDia')"
            :disabled="busy" />

          <!-- Comienzo y fin, uno al lado del otro cuando el diálogo da el ancho
               y apilados cuando no: el envoltorio es un contenedor. -->
          <div class="@container">
            <div class="grid grid-cols-1 gap-4 @sm:grid-cols-2">
              <FormGroup :label="t('editor.comienzo')" v-slot="{ id }">
                <TextInput
                  :id="id"
                  v-model="form.start"
                  :type="form.allDay ? 'date' : 'datetime-local'"
                  :disabled="busy" />
              </FormGroup>
              <FormGroup :label="t('editor.fin')" v-slot="{ id }">
                <TextInput
                  :id="id"
                  v-model="form.end"
                  :type="form.allDay ? 'date' : 'datetime-local'"
                  :disabled="busy" />
              </FormGroup>
            </div>
          </div>

          <FormGroup :label="t('editor.ubicacion')" v-slot="{ id }">
            <TextInput
              :id="id"
              v-model="form.location"
              :placeholder="t('editor.ubicacionPlaceholder')"
              :disabled="busy" />
          </FormGroup>

          <FormGroup :label="t('editor.descripcion')" v-slot="{ id }">
            <TextArea :id="id" v-model="form.description" :rows="3" :disabled="busy" />
          </FormGroup>

          <!-- Lo que falta (validación) o lo que falló al escribir (del padre),
               anunciado para el lector de pantalla. -->
          <p
            v-if="localError || error"
            class="text-body-s text-tx-muted"
            role="status">
            {{ localError || error }}
          </p>

          <!-- Editar está en pausa hasta que el almacén dé el ETag: se dice, para
               que «Guardar» apagado no parezca un error. -->
          <p
            v-if="mode === 'edit' && !canSave"
            class="text-body-s text-tx-muted"
            role="note">
            {{ t('editor.pendiente') }}
          </p>
        </div>
      </DialogBody>

      <DialogFooter>
        <!-- Borrar, con una confirmación en el mismo pie: un clic lo pide, el
             segundo lo hace. -->
        <template v-if="mode === 'edit'">
          <template v-if="confirmingDelete">
            <ActionButton
              variant="secondary"
              :label="t('editor.cancelar')"
              :disabled="busy"
              @click="confirmingDelete = false" />
            <ActionButton
              variant="danger"
              :label="t('editor.borrarConfirmar')"
              :loading="busy"
              @click="onDelete" />
          </template>
          <template v-else>
            <ActionButton
              variant="danger"
              icon="user-trash"
              :label="t('editor.borrar')"
              :disabled="busy"
              @click="confirmingDelete = true" />
            <ActionButton
              variant="primary"
              :label="t('editor.guardar')"
              :disabled="busy || !canSave"
              @click="onSave" />
          </template>
        </template>
        <template v-else>
          <ActionButton
            variant="secondary"
            :label="t('editor.cancelar')"
            :disabled="busy"
            @click="close" />
          <ActionButton
            variant="primary"
            :label="t('editor.guardar')"
            :loading="busy"
            @click="onSave" />
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
