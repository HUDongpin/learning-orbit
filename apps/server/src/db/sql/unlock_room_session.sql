SELECT pg_advisory_unlock(learning_orbit_room_lock_key($1::uuid));
