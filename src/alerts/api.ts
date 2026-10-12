/** Alert HTTP calls (docs/CONTRACT.md, "Alerts"). Every request goes through `apiRequest`. */
import type {
  Alert,
  AlertEventsResponse,
  AlertsResponse,
  CreateAlertBody,
  EntityId,
  SetCheckedBody,
  UnixSeconds,
  UpdateAlertBody,
} from '@shared/types';
import { apiRequest } from '../data';

export const fetchAlerts = (signal?: AbortSignal) => apiRequest<AlertsResponse>('/alerts', { signal });

export const createAlert = (body: CreateAlertBody) => apiRequest<Alert>('/alerts', { method: 'POST', body });

export const updateAlert = (id: EntityId, body: UpdateAlertBody) =>
  apiRequest<Alert>(`/alerts/${encodeURIComponent(id)}`, { method: 'PUT', body });

export const deleteAlert = (id: EntityId) =>
  apiRequest<{ id: EntityId }>(`/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const fetchAlertEvents = (since?: UnixSeconds, signal?: AbortSignal) =>
  apiRequest<AlertEventsResponse>('/alerts/events', { ...(since === undefined ? {} : { params: { since: String(since) } }), signal });

export const setEventsChecked = (body: SetCheckedBody) =>
  apiRequest<{ unchecked: number }>('/alerts/events/checked', { method: 'PUT', body });

export const deleteAlertEvent = (id: EntityId) =>
  apiRequest<{ unchecked: number }>(`/alerts/events/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** The stream URL, same origin as `apiRequest`. */
export const ALERT_STREAM_URL = '/api/alerts/stream';
