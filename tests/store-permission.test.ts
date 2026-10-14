/**
 * Las marcas del permiso del almacén que el programa de Rust le pasa a la
 * ventana (`src/tools/store-permission.ts`). El texto lo pone la ventana en el
 * idioma de la sesión; acá se prueba que cada marca y cada desenlace caigan
 * donde tienen que caer, y que uno desconocido no se escape como mensaje crudo.
 */

import { describe, expect, test } from 'bun:test';
import {
	isStorePermissionDenied,
	type ReaskOutcome,
	reaskNoticeKey,
	shouldReread,
	STORE_PERMISSION_DENIED,
} from '@/tools/store-permission';

describe('reconocer el «no» del almacén', () => {
	test('la marca exacta es un «no»', () => {
		expect(isStorePermissionDenied(STORE_PERMISSION_DENIED)).toBe(true);
	});

	test('cualquier otro error no lo es', () => {
		expect(isStorePermissionDenied('el servicio no está')).toBe(false);
		// Un `Error` que envuelve la marca no es la marca: su texto es
		// «Error: store-permission-denied», no la marca pelada.
		expect(isStorePermissionDenied(new Error(STORE_PERMISSION_DENIED))).toBe(false);
		expect(isStorePermissionDenied(undefined)).toBe(false);
		expect(isStorePermissionDenied(null)).toBe(false);
	});
});

describe('el desenlace de volver a pedir', () => {
	test('sólo «reopened» manda releer', () => {
		expect(shouldReread({ outcome: 'reopened' })).toBe(true);
		expect(shouldReread({ outcome: 'too_soon' })).toBe(false);
		expect(shouldReread({ outcome: 'not_allowed' })).toBe(false);
		expect(shouldReread({ outcome: 'failed', detail: 'x' })).toBe(false);
		expect(shouldReread(undefined)).toBe(false);
		expect(shouldReread(null)).toBe(false);
	});

	test('cada desenlace tiene su aviso, y «reopened» ninguno', () => {
		expect(reaskNoticeKey({ outcome: 'reopened' })).toBeNull();
		expect(reaskNoticeKey({ outcome: 'too_soon' })).toBe('permiso.limite');
		expect(reaskNoticeKey({ outcome: 'not_allowed' })).toBe('permiso.denegado');
		expect(reaskNoticeKey({ outcome: 'failed', detail: 'x' })).toBe('permiso.error');
	});

	test('un desenlace desconocido cae en el mensaje genérico, no en algo crudo', () => {
		expect(reaskNoticeKey({ outcome: 'vaya-a-saber' } as unknown as ReaskOutcome)).toBe(
			'permiso.error'
		);
		expect(reaskNoticeKey(undefined)).toBe('permiso.error');
		expect(reaskNoticeKey(null)).toBe('permiso.error');
	});
});
