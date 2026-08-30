SELECT format('CREATE DATABASE %I OWNER %I', 'learning_orbit_test', 'learning_orbit')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'learning_orbit_test'
)
\gexec
