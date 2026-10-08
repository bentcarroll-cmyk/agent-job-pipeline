"""Fabricated career facts for the two shared synthetic candidates only."""
import json
from pathlib import Path
from tools.materials.workspace import load_workspace_config


def candidate(root: Path, engineering=False):
    root.mkdir(parents=True, exist_ok=True)
    name = 'Morgan Example' if engineering else 'Alex Example'
    occupation = 'Software Engineering' if engineering else 'Operations'
    location = 'Boston, MA' if engineering else 'Chicago, IL'
    contact = {'location': location, 'phone': '202-555-0100', 'email': ('morgan' if engineering else 'alex') + '@example.invalid', 'linkedin': 'https://example.invalid/profile'}
    operations = [
        'Designed a weekly capacity review across three fictional service teams, comparing incoming demand with staffing plans and documenting clear escalation decisions so managers could address bottlenecks before they affected delivery commitments.',
        'Created a standard operating procedure for exception triage, assigned accountable owners to each unresolved case, and tracked recurring causes in a shared review log to improve handoffs between planning and delivery teams.',
        'Led a cross-functional improvement project that mapped the full order workflow, tested revised intake criteria with frontline colleagues, and introduced measured checkpoints to make service quality and operational tradeoffs visible to decision makers.',
        'Built a practical performance dashboard from synthetic service records, reconciled inconsistent definitions with finance partners, and used weekly reviews to distinguish verified outcomes from hypotheses that needed additional investigation before changing staffing plans.',
        'Coordinated launch readiness for a fictional customer program by documenting dependencies, rehearsing failure scenarios with service owners, and maintaining a decision log that connected each unresolved risk to an accountable manager and follow-up date.',
        'Established a training and feedback process for new coordinators, observed their handling of sample exceptions, and revised guidance when practical tests showed that unclear instructions were creating avoidable rework across the operating team.',
    ]
    engineering_bullets = [
        'Designed a typed service boundary for a fictional scheduling platform, implemented deterministic validation before database writes, and tested timeout and duplicate delivery cases to preserve durable records when downstream integrations failed during request processing.',
        'Built an asynchronous processing pipeline with idempotent operations, explicit retry budgets, and traceable event receipts so engineers could reconcile uncertain outcomes without creating duplicate work or silently losing customer requests during recovery.',
        'Introduced contract tests for software interfaces between four synthetic services, documented ownership of schema changes, and used representative failure fixtures to verify that incompatible responses produced actionable diagnostics before a release reached staging.',
        'Improved a synthetic application deployment process by separating build validation from runtime acceptance, reviewing configuration changes independently, and recording the exact candidate revision associated with each successful test and operational readiness decision.',
        'Developed a service performance review using reproducible workloads, compared latency distributions across alternative implementations, and identified the database access pattern responsible for unnecessary processing before implementing a bounded query optimization.',
        'Mentored engineers through design reviews and production-style incident exercises, explained failure modes in plain language, and translated recurring lessons into focused regression tests that protected the reliability of the fictional platform interfaces.',
    ]
    bullets = engineering_bullets if engineering else operations
    roles = [{'company': f'SYNTHETIC {occupation.upper()} {i+1}', 'title': f'{occupation} ' + ('Lead' if i == 0 else 'Manager'), 'dates': dates, 'context': 'Fabricated career history used only to verify private package generation.', 'bullets': bullets} for i, dates in enumerate(['January 2024 - Present', 'January 2021 - December 2023', 'January 2018 - December 2020', 'January 2015 - December 2017'])]
    roles[-1]['bullets'] = bullets[:4]
    content = {'name': name, 'headline': f'{occupation} Leadership', 'contact': contact, 'summary': f'{occupation} leader with fabricated experience building reliable workflows, connecting decisions to evidence, and helping cross-functional teams improve measurable outcomes. This synthetic candidate profile contains no real personal career information.', 'expertise': f'{occupation} | Project Delivery | Cross-functional Collaboration | Evidence Review', 'roles': roles, 'education': [{'institution': 'Synthetic University', 'degree': 'Bachelor of Science, Computer Science' if engineering else 'Bachelor of Science, Operations Management'}], 'skillGroups': [{'label': 'Tools', 'items': 'Python, TypeScript, SQL, automated testing' if engineering else 'Capacity planning, service reviews, process mapping, dashboards'}]}
    facts = [{'id': 'identity', 'text': name}, {'id': 'scope', 'text': 'Four service teams'}] + [{'id': f'bullet-{i}', 'text': value.replace('three fictional service teams', 'four fictional service teams') if i == 0 else value} for i, value in enumerate(bullets)]
    (root/'Career_Evidence.md').write_text('# Fabricated career evidence\n\n```json\n' + json.dumps({'schemaVersion': 1, 'facts': facts, 'corrections': [{'id': 'scope', 'text': 'Three service teams'}, {'id': 'bullet-0', 'text': bullets[0]}]}, indent=2) + '\n```\n')
    (root/'Writing_Preferences.md').write_text('Plain language; two-page resume; one-page cover letter; no unsupported claims.\n')
    (root/'instance.json').write_text(json.dumps({'schemaVersion': 1, 'instanceId': 'boston-engineering' if engineering else 'chicago-operations', 'cloudflare': {'databaseName': 'synthetic-db', 'databaseId': 'synthetic-id'}}))
    config_path = root/'materials.json'
    config_path.write_text(json.dumps({'schemaVersion': 1, 'workspaceRoot': str(root), 'careerEvidencePath': 'Career_Evidence.md', 'writingPreferencesPath': 'Writing_Preferences.md', 'applicationsRoot': 'applications', 'instanceConfigPath': 'instance.json', 'resumePages': 2, 'coverLetterEnabled': True}))
    letter = {'name': name, 'contact': contact, 'date': 'October 8, 2026', 'subject': f'Application for {occupation} Lead at Synthetic Company', 'salutation': 'Dear Hiring Team,', 'paragraphs': [f'I am interested in the {occupation} Lead role at Synthetic Company. My fictional career reflects a consistent focus on reliable delivery, evidence-based decisions, and practical collaboration across teams. I would bring those habits to the responsibilities described in your synthetic posting.', bullets[0], bullets[2], f'The opportunity to connect {occupation.lower()} priorities to clear operating outcomes is a strong fit for this fabricated profile. I would welcome a conversation about the team\'s current constraints, the decisions this role owns, and the measures that would demonstrate successful delivery.'], 'signoff': 'Sincerely,'}
    posting = {'id': 'synthetic:boston:engineering-1' if engineering else 'synthetic:chicago:operations-1', 'company': 'Synthetic Company', 'title': f'{occupation} Lead', 'location': location}
    config = load_workspace_config(config_path)
    from tools.materials.workspace import load_evidence
    corrected = load_evidence(config)
    bullets[0] = corrected['bullet-0']
    return config, posting, content, letter
