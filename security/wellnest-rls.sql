-- WellNest security hardening: production RLS policies
-- WARNING: this intentionally replaces all existing policies on the listed
-- application tables so an old permissive policy cannot silently bypass the
-- hardened policy set. The apply script writes a JSON backup first.

BEGIN;

CREATE OR REPLACE FUNCTION public.wellnest_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT role = 'ADMIN'::public.user_role
      FROM public.users
      WHERE id = auth.uid()
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.wellnest_is_caregiver_for(p_senior uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.caregiver_senior
    WHERE caregiver_id = auth.uid()
      AND senior_id = p_senior
  );
$$;

CREATE OR REPLACE FUNCTION public.wellnest_is_related_user(p_other uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.caregiver_senior
    WHERE
      (caregiver_id = auth.uid() AND senior_id = p_other)
      OR
      (senior_id = auth.uid() AND caregiver_id = p_other)
  );
$$;

CREATE OR REPLACE FUNCTION public.wellnest_can_view_senior(p_senior uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = p_senior
    OR public.wellnest_is_admin()
    OR public.wellnest_is_caregiver_for(p_senior);
$$;

CREATE OR REPLACE FUNCTION public.wellnest_can_manage_senior(p_senior uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.wellnest_is_admin()
    OR public.wellnest_is_caregiver_for(p_senior);
$$;

CREATE OR REPLACE FUNCTION public.wellnest_can_view_device(p_device uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.devices d
    WHERE d.id = p_device
      AND d.senior_id IS NOT NULL
      AND public.wellnest_can_view_senior(d.senior_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.wellnest_can_view_schedule(p_schedule uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.medication_schedules s
    WHERE s.id = p_schedule
      AND s.senior_id IS NOT NULL
      AND public.wellnest_can_view_senior(s.senior_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.wellnest_can_manage_schedule(p_schedule uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.medication_schedules s
    WHERE s.id = p_schedule
      AND s.senior_id IS NOT NULL
      AND (
        auth.uid() = s.senior_id
        OR public.wellnest_can_manage_senior(s.senior_id)
      )
  );
$$;

-- Ensure callers can use policy helper functions.
GRANT EXECUTE ON FUNCTION public.wellnest_is_admin() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wellnest_is_caregiver_for(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wellnest_is_related_user(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wellnest_can_view_senior(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wellnest_can_manage_senior(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wellnest_can_view_device(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wellnest_can_view_schedule(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wellnest_can_manage_schedule(uuid) TO anon, authenticated;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'users',
        'caregiver_senior',
        'devices',
        'thresholds',
        'daily_checkins',
        'caregiver_journal',
        'medication_schedules',
        'medication_logs',
        'messages',
        'alerts',
        'environmental_readings',
        'activity_events'
      ])
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      p.policyname,
      p.schemaname,
      p.tablename
    );
  END LOOP;
END $$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caregiver_senior ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caregiver_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.environmental_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;

-- USERS
CREATE POLICY users_select
ON public.users FOR SELECT TO authenticated
USING (
  id = auth.uid()
  OR public.wellnest_is_admin()
  OR public.wellnest_is_related_user(id)
);

CREATE POLICY users_insert_self
ON public.users FOR INSERT TO authenticated
WITH CHECK (
  id = auth.uid()
  AND role IN ('CAREGIVER'::public.user_role, 'SENIOR'::public.user_role)
);

CREATE POLICY users_update_self_or_admin
ON public.users FOR UPDATE TO authenticated
USING (id = auth.uid() OR public.wellnest_is_admin())
WITH CHECK (
  public.wellnest_is_admin()
  OR (
    id = auth.uid()
    AND role = (
      SELECT u.role FROM public.users u WHERE u.id = auth.uid()
    )
  )
);

CREATE POLICY users_delete_admin
ON public.users FOR DELETE TO authenticated
USING (public.wellnest_is_admin());

-- CAREGIVER ↔ SENIOR RELATIONSHIPS
CREATE POLICY caregiver_senior_select
ON public.caregiver_senior FOR SELECT TO authenticated
USING (
  public.wellnest_is_admin()
  OR caregiver_id = auth.uid()
  OR senior_id = auth.uid()
);

CREATE POLICY caregiver_senior_write_admin
ON public.caregiver_senior FOR ALL TO authenticated
USING (public.wellnest_is_admin())
WITH CHECK (public.wellnest_is_admin());

-- DEVICES
CREATE POLICY devices_select
ON public.devices FOR SELECT TO authenticated
USING (
  public.wellnest_is_admin()
  OR (senior_id IS NOT NULL AND public.wellnest_can_view_senior(senior_id))
);

CREATE POLICY devices_insert_admin
ON public.devices FOR INSERT TO authenticated
WITH CHECK (public.wellnest_is_admin());

CREATE POLICY devices_update_admin
ON public.devices FOR UPDATE TO authenticated
USING (public.wellnest_is_admin())
WITH CHECK (public.wellnest_is_admin());

CREATE POLICY devices_delete_admin
ON public.devices FOR DELETE TO authenticated
USING (public.wellnest_is_admin());

-- THRESHOLDS
CREATE POLICY thresholds_select
ON public.thresholds FOR SELECT TO authenticated
USING (
  public.wellnest_is_admin()
  OR senior_id IS NULL
  OR public.wellnest_can_view_senior(senior_id)
);

CREATE POLICY thresholds_insert
ON public.thresholds FOR INSERT TO authenticated
WITH CHECK (
  public.wellnest_is_admin()
  OR (
    senior_id IS NOT NULL
    AND public.wellnest_can_manage_senior(senior_id)
  )
);

CREATE POLICY thresholds_update
ON public.thresholds FOR UPDATE TO authenticated
USING (
  public.wellnest_is_admin()
  OR (
    senior_id IS NOT NULL
    AND public.wellnest_can_manage_senior(senior_id)
  )
)
WITH CHECK (
  public.wellnest_is_admin()
  OR (
    senior_id IS NOT NULL
    AND public.wellnest_can_manage_senior(senior_id)
  )
);

CREATE POLICY thresholds_delete
ON public.thresholds FOR DELETE TO authenticated
USING (
  public.wellnest_is_admin()
  OR (
    senior_id IS NOT NULL
    AND public.wellnest_can_manage_senior(senior_id)
  )
);

-- DAILY CHECK-INS
CREATE POLICY daily_checkins_select
ON public.daily_checkins FOR SELECT TO authenticated
USING (
  senior_id IS NOT NULL
  AND public.wellnest_can_view_senior(senior_id)
);

CREATE POLICY daily_checkins_insert_own
ON public.daily_checkins FOR INSERT TO authenticated
WITH CHECK (senior_id = auth.uid());

-- CAREGIVER JOURNAL
CREATE POLICY caregiver_journal_select
ON public.caregiver_journal FOR SELECT TO authenticated
USING (
  senior_id IS NOT NULL
  AND public.wellnest_can_view_senior(senior_id)
);

CREATE POLICY caregiver_journal_insert
ON public.caregiver_journal FOR INSERT TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND senior_id IS NOT NULL
  AND (
    public.wellnest_is_admin()
    OR public.wellnest_is_caregiver_for(senior_id)
  )
);

CREATE POLICY caregiver_journal_update
ON public.caregiver_journal FOR UPDATE TO authenticated
USING (author_id = auth.uid() OR public.wellnest_is_admin())
WITH CHECK (author_id = auth.uid() OR public.wellnest_is_admin());

CREATE POLICY caregiver_journal_delete
ON public.caregiver_journal FOR DELETE TO authenticated
USING (author_id = auth.uid() OR public.wellnest_is_admin());

-- MEDICATION SCHEDULES
CREATE POLICY medication_schedules_select
ON public.medication_schedules FOR SELECT TO authenticated
USING (
  senior_id IS NOT NULL
  AND public.wellnest_can_view_senior(senior_id)
);

CREATE POLICY medication_schedules_insert
ON public.medication_schedules FOR INSERT TO authenticated
WITH CHECK (
  senior_id IS NOT NULL
  AND (
    senior_id = auth.uid()
    OR public.wellnest_can_manage_senior(senior_id)
  )
);

CREATE POLICY medication_schedules_update
ON public.medication_schedules FOR UPDATE TO authenticated
USING (
  senior_id IS NOT NULL
  AND (
    senior_id = auth.uid()
    OR public.wellnest_can_manage_senior(senior_id)
  )
)
WITH CHECK (
  senior_id IS NOT NULL
  AND (
    senior_id = auth.uid()
    OR public.wellnest_can_manage_senior(senior_id)
  )
);

CREATE POLICY medication_schedules_delete
ON public.medication_schedules FOR DELETE TO authenticated
USING (
  senior_id IS NOT NULL
  AND (
    senior_id = auth.uid()
    OR public.wellnest_can_manage_senior(senior_id)
  )
);

-- MEDICATION LOGS
CREATE POLICY medication_logs_select
ON public.medication_logs FOR SELECT TO authenticated
USING (
  schedule_id IS NOT NULL
  AND public.wellnest_can_view_schedule(schedule_id)
);

CREATE POLICY medication_logs_insert
ON public.medication_logs FOR INSERT TO authenticated
WITH CHECK (
  schedule_id IS NOT NULL
  AND public.wellnest_can_manage_schedule(schedule_id)
);

-- MESSAGES
CREATE POLICY messages_select
ON public.messages FOR SELECT TO authenticated
USING (
  sender_id = auth.uid()
  OR receiver_id = auth.uid()
);

CREATE POLICY messages_insert
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND receiver_id IS NOT NULL
  AND public.wellnest_is_related_user(receiver_id)
);

-- ALERTS
CREATE POLICY alerts_select
ON public.alerts FOR SELECT TO authenticated
USING (
  senior_id IS NOT NULL
  AND public.wellnest_can_view_senior(senior_id)
);

CREATE POLICY alerts_insert_own_emergency
ON public.alerts FOR INSERT TO authenticated
WITH CHECK (
  senior_id = auth.uid()
);

CREATE POLICY alerts_update_caregiver_or_admin
ON public.alerts FOR UPDATE TO authenticated
USING (
  senior_id IS NOT NULL
  AND public.wellnest_can_manage_senior(senior_id)
)
WITH CHECK (
  senior_id IS NOT NULL
  AND public.wellnest_can_manage_senior(senior_id)
);

CREATE POLICY alerts_delete_admin
ON public.alerts FOR DELETE TO authenticated
USING (public.wellnest_is_admin());

-- SENSOR DATA (read-only to web clients)
CREATE POLICY environmental_readings_select
ON public.environmental_readings FOR SELECT TO authenticated
USING (
  device_id IS NOT NULL
  AND public.wellnest_can_view_device(device_id)
);

CREATE POLICY activity_events_select
ON public.activity_events FOR SELECT TO authenticated
USING (
  device_id IS NOT NULL
  AND public.wellnest_can_view_device(device_id)
);

COMMIT;
