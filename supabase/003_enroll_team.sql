-- FIRST: Dashboard > Authentication > Users > Add user > Create new user.
-- Use a real teammate email, a private password, and Auto Confirm User.
-- Copy that user's UID. Then replace the UUID and name below and run this.
-- Repeat for all six teammates. Do not give customer accounts staff access.
-- This intentionally does not enroll all people who sign up.

-- insert into public.team_members(user_id,display_name)
-- values ('PASTE-USER-UID-HERE'::uuid, 'Colby')
-- on conflict(user_id) do update set display_name=excluded.display_name;

-- Leave the commented lines commented until you replace the placeholders.
select display_name,user_id from public.team_members order by display_name;
