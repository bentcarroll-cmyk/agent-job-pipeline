"""A fabricated, explicitly requested material package joined to a real local D1 job."""
import json
import sys
from pathlib import Path
from unittest.mock import patch
from synthetic import candidate
from tools.materials.existing_package import reserve_package
from tools.materials.render_resume import render_resume
from tools.materials.render_letter import render_letter
from tools.materials.measure_space import measure
from tools.materials import jobs_queue
from pypdf import PdfReader
import pdfplumber

root, engineering, job_id = Path(sys.argv[1]), sys.argv[2] == 'true', sys.argv[3]
config, posting, content, letter = candidate(root/'private', engineering)
posting['id'] = job_id
package = reserve_package(config, posting)
assert reserve_package(config, posting) == package
resume, cover = package/'resume.pdf', package/'letter.pdf'
pages = [render_resume(content, str(resume), workspace_config=config), render_letter(letter, str(cover), workspace_config=config)]
for path in [resume, cover]:
    with pdfplumber.open(path) as pdf:
        text = '\n'.join(p.extract_text() for p in pdf.pages)
    independent = '\n'.join(p.extract_text() for p in PdfReader(path).pages)
    assert content['name'].upper() in text.upper() and content['name'].upper() in independent.upper()
    assert ('Alex Example' if engineering else 'Morgan Example').upper() not in independent.upper()
assert all(p['fill_ratio'] >= .8 for p in measure(str(resume), 'resume')['pages'])
assert measure(str(cover), 'letter')['pages'][0]['fill_ratio'] >= .5
queue_sql = []
def selected_query(sql, instance_config_path):
    assert instance_config_path == config.instance_config_path
    queue_sql.append(sql)
    return json.dumps([{'success':True,'results':[],'meta':{'changes':1}}])
with patch.object(jobs_queue, '_run_wrangler', selected_query):
    jobs_queue.set_status(job_id, 'materials_ready', config.instance_config_path)
print(json.dumps({'jobId':job_id,'pages':pages,'state':json.loads((package/'package.json').read_text())['state'],'repeatSame':True,'queueSql':queue_sql,'package':str(package)}))
