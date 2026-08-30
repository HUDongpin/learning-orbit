SELECT pg_advisory_xact_lock(learning_orbit_room_lock_key($1::uuid));
