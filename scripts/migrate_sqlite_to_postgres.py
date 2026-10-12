"""Copy a SQLite snapshot to an empty, migrated PostgreSQL database through Docker psql.
Preserves IDs and encrypted configs. Does not modify the SQLite source or copy files.
The target must have been initialized by this version of atlas-server. Stops on any error.
"""
import argparse
import sqlite3
import subprocess
from pathlib import Path

ORDER = ['tenants','departments','users','sessions','login_attempts','oidc_states','spaces','grants','documents','document_versions','chunks','index_jobs','api_keys','audit_events','conversations','messages','tenant_model_configs','agent_message_metadata','studio_projects','studio_messages','studio_jobs','studio_assets','storage_profiles','tenant_storage_configs','object_locations','personal_spaces','user_preferences','studio_archives','document_cleanup_jobs','vector_collections','vector_jobs','bot_tasks','bot_events','bot_artifacts','bot_connectors','bot_actions','bot_skills','bot_runtime','bot_tool_calls']

def literal(value):
    if value is None: return 'NULL'
    if isinstance(value, (int, float)): return str(value)
    return "'" + str(value).replace("'", "''") + "'"

def migrate(source, container):
    source = Path(source).resolve()
    if not source.is_file(): raise RuntimeError('SQLite source does not exist')
    db = sqlite3.connect(f'file:{source}?mode=ro&immutable=1', uri=True)
    db.row_factory = sqlite3.Row
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    sql = ["BEGIN;", "DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenants) THEN RAISE EXCEPTION 'Target database must be empty'; END IF; END $$;"]
    deferred = []
    counts = {}
    for table in ORDER:
        if table not in tables: continue
        rows = db.execute(f'SELECT * FROM "{table}"').fetchall()
        counts[table] = len(rows)
        for row in rows:
            values = dict(row)
            parent = 'parent_id' if table == 'departments' else 'manager_id' if table == 'users' else None
            if parent and values[parent] is not None:
                deferred.append(f'UPDATE "{table}" SET "{parent}"={literal(values[parent])} WHERE id={literal(values["id"])};')
                values[parent] = None
            columns = ','.join('"'+name+'"' for name in values)
            sql.append(f'INSERT INTO "{table}" ({columns}) VALUES ({",".join(literal(v) for v in values.values())});')
    sql += deferred + ['COMMIT;']
    db.close()
    result = subprocess.run(['docker','exec','-i',container,'psql','-U','atlas','-d','atlas','-v','ON_ERROR_STOP=1'], input='\n'.join(sql), text=True, capture_output=True)
    if result.returncode:
        # Do not emit SQL or encrypted payloads from diagnostic context.
        raise RuntimeError('Migration rolled back. Check target schema and source compatibility; no source data was changed.')
    print('Migrated rows:', {k:v for k,v in counts.items() if v})

if __name__ == '__main__':
    args = argparse.ArgumentParser()
    args.add_argument('snapshot')
    args.add_argument('--container', default='atlas-local-postgres-1')
    options = args.parse_args()
    migrate(options.snapshot, options.container)
