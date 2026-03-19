import { z } from 'zod';

// --- Users ---

export const createUserSchema = z.object({
  name: z.string().min(1, 'El nombre es requerido').max(200),
  email: z.string().email('Email no válido'),
  phone: z.string().optional().nullable(),
  role: z.enum(['admin', 'operator']).default('operator'),
  rdn_user_id: z.string().optional().nullable(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional().nullable(),
  role: z.enum(['admin', 'operator']).optional(),
});

export const linkRdnSchema = z.object({
  rdn_user_id: z.string().min(1, 'rdn_user_id es requerido'),
});

export const matchEmailSchema = z.object({
  email: z.string().email('Email no válido'),
});

export const availabilitySchema = z.object({
  available: z.boolean(),
});

// --- Queues ---

export const createQueueSchema = z.object({
  name: z.string().min(1, 'El nombre es requerido').max(200),
  strategy: z.enum(['ring_all', 'round_robin']).default('ring_all'),
  ring_timeout: z.number().int().min(5).max(120).default(25),
  max_wait_time: z.number().int().min(30).max(600).default(180),
  wait_message: z.string().optional().nullable(),
  wait_music_url: z.string().url().optional().nullable(),
  timeout_action: z.enum(['hangup', 'forward', 'voicemail', 'keep_waiting']).default('hangup'),
  timeout_forward_to: z.string().optional().nullable(),
  rotation_interval: z.number().int().min(1).max(1440).default(15),
});

export const updateQueueSchema = createQueueSchema.partial();

export const assignQueueUserSchema = z.object({
  user_id: z.string().uuid('user_id debe ser un UUID válido'),
  priority: z.number().int().min(0).default(0),
});

// --- Schedules ---

export const scheduleSlotSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Formato HH:mm')
    .transform((value) => value.slice(0, 5)),
  end_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Formato HH:mm')
    .transform((value) => value.slice(0, 5)),
});

export const createScheduleSchema = z.object({
  name: z.string().min(1, 'El nombre es requerido').max(200),
  timezone: z.string().default('Europe/Madrid'),
  slots: z.array(scheduleSlotSchema).optional(),
});

export const updateScheduleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: z.string().optional(),
  slots: z.array(scheduleSlotSchema).optional(),
});

// --- Phone Numbers ---

export const updatePhoneNumberSchema = z.object({
  friendly_name: z.string().optional().nullable(),
  queue_id: z.string().uuid().optional().nullable(),
  forward_to: z.string().optional().nullable(),
  schedule_id: z.string().uuid().optional().nullable(),
  welcome_message: z.string().optional().nullable(),
  ooh_message: z.string().optional().nullable(),
  ooh_action: z.enum(['hangup', 'forward', 'voicemail']).optional(),
  ooh_forward_to: z.string().optional().nullable(),
  record_calls: z.boolean().optional(),
  active: z.boolean().optional(),
});

// --- Calls ---

export const dialSchema = z.object({
  destination_number: z.string().min(5, 'Número destino requerido'),
  from_number: z.string().min(5, 'Número de origen requerido'),
});
