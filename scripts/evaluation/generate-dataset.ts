#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import type { EvaluationLanguage, EvaluationQueryRecord } from "../../lib/evaluation/types";

type LocalizedText = Record<EvaluationLanguage, string>;
type LocalizedPoints = Record<EvaluationLanguage, string[]>;

type DocumentBlueprint = {
  id: string;
  pages: number[];
  section: LocalizedText;
  focus: LocalizedText;
  points: LocalizedPoints;
};

const LANGUAGES: EvaluationLanguage[] = ["EN", "DE", "FR", "IT", "ES"];

const DOCUMENTS: DocumentBlueprint[] = [
  {
    id: "doc_company_profile",
    pages: [1, 2],
    section: {
      EN: "Company Overview",
      DE: "Unternehmensprofil",
      FR: "Profil de l entreprise",
      IT: "Profilo aziendale",
      ES: "Perfil de la empresa",
    },
    focus: {
      EN: "ownership structure and leadership",
      DE: "Eigentumsstruktur und Fuehrung",
      FR: "structure de propriete et direction",
      IT: "struttura proprietaria e leadership",
      ES: "estructura de propiedad y liderazgo",
    },
    points: {
      EN: ["Ownership model is documented", "Leadership team responsibilities are listed", "Core business lines are described"],
      DE: ["Eigentuemerstruktur ist dokumentiert", "Verantwortungen des Fuehrungsteams sind aufgefuehrt", "Kern-Geschaeftsbereiche sind beschrieben"],
      FR: ["Le modele de propriete est documente", "Les responsabilites de la direction sont listees", "Les activites principales sont decrites"],
      IT: ["Il modello proprietario e documentato", "Le responsabilita del management sono elencate", "Le linee di business principali sono descritte"],
      ES: ["El modelo de propiedad esta documentado", "Las responsabilidades del equipo directivo estan listadas", "Las lineas de negocio clave estan descritas"],
    },
  },
  {
    id: "doc_financial_statements",
    pages: [8, 9],
    section: {
      EN: "Financial Performance",
      DE: "Finanzielle Entwicklung",
      FR: "Performance financiere",
      IT: "Performance finanziaria",
      ES: "Rendimiento financiero",
    },
    focus: {
      EN: "revenue trend and profitability",
      DE: "Umsatztrend und Profitabilitaet",
      FR: "tendance du chiffre d affaires et rentabilite",
      IT: "trend dei ricavi e redditivita",
      ES: "tendencia de ingresos y rentabilidad",
    },
    points: {
      EN: ["Year-over-year revenue trend is stated", "Margin movement is quantified", "Main cost drivers are identified"],
      DE: ["Der Umsatztrend im Jahresvergleich ist genannt", "Die Margenentwicklung ist quantifiziert", "Wesentliche Kostentreiber sind benannt"],
      FR: ["La tendance des revenus annuels est indiquee", "L evolution des marges est quantifiee", "Les principaux facteurs de cout sont identifies"],
      IT: ["Il trend dei ricavi anno su anno e indicato", "La variazione dei margini e quantificata", "I principali driver di costo sono identificati"],
      ES: ["La tendencia anual de ingresos esta indicada", "La evolucion del margen esta cuantificada", "Los principales impulsores de costos estan identificados"],
    },
  },
  {
    id: "doc_legal_compliance",
    pages: [12, 13],
    section: {
      EN: "Regulatory Compliance",
      DE: "Regulatorische Compliance",
      FR: "Conformite reglementaire",
      IT: "Conformita normativa",
      ES: "Cumplimiento regulatorio",
    },
    focus: {
      EN: "open legal exposure",
      DE: "offene rechtliche Risiken",
      FR: "exposition juridique ouverte",
      IT: "esposizione legale aperta",
      ES: "exposicion legal abierta",
    },
    points: {
      EN: ["Applicable regulations are listed", "Open investigations are disclosed", "Mitigation and remediation actions are tracked"],
      DE: ["Relevante Vorschriften sind aufgefuehrt", "Offene Untersuchungen sind offengelegt", "Massnahmen und Remediation sind nachverfolgt"],
      FR: ["Les regles applicables sont listees", "Les enquetes en cours sont divulguees", "Les actions de remediation sont suivies"],
      IT: ["Le normative applicabili sono elencate", "Le indagini aperte sono dichiarate", "Le azioni di mitigazione sono monitorate"],
      ES: ["Las regulaciones aplicables estan listadas", "Las investigaciones abiertas estan reveladas", "Las acciones de mitigacion y remediacion estan registradas"],
    },
  },
  {
    id: "doc_market_analysis",
    pages: [16, 17],
    section: {
      EN: "Market Positioning",
      DE: "Marktpositionierung",
      FR: "Positionnement sur le marche",
      IT: "Posizionamento di mercato",
      ES: "Posicionamiento de mercado",
    },
    focus: {
      EN: "competitive differentiation",
      DE: "wettbewerbliche Differenzierung",
      FR: "differenciation concurrentielle",
      IT: "differenziazione competitiva",
      ES: "diferenciacion competitiva",
    },
    points: {
      EN: ["Target segments are defined", "Competitor comparison is provided", "Unique value proposition is articulated"],
      DE: ["Zielsegmente sind definiert", "Wettbewerbsvergleich ist vorhanden", "Einzigartige Wertposition ist klar beschrieben"],
      FR: ["Les segments cibles sont definis", "Une comparaison concurrentielle est fournie", "La proposition de valeur unique est formulee"],
      IT: ["I segmenti target sono definiti", "E presente un confronto con i concorrenti", "La proposta di valore unica e descritta"],
      ES: ["Los segmentos objetivo estan definidos", "Se proporciona comparacion con competidores", "La propuesta de valor unica esta formulada"],
    },
  },
  {
    id: "doc_operations_report",
    pages: [20, 21],
    section: {
      EN: "Operational Performance",
      DE: "Operative Leistung",
      FR: "Performance operationnelle",
      IT: "Performance operativa",
      ES: "Rendimiento operativo",
    },
    focus: {
      EN: "capacity constraints and delivery quality",
      DE: "Kapazitaetsengpaesse und Lieferqualitaet",
      FR: "contraintes de capacite et qualite de livraison",
      IT: "vincoli di capacita e qualita di consegna",
      ES: "restricciones de capacidad y calidad de entrega",
    },
    points: {
      EN: ["Capacity utilization is quantified", "Service-level or delivery KPIs are tracked", "Operational bottlenecks and actions are described"],
      DE: ["Kapazitaetsauslastung ist quantifiziert", "Service- und Liefer-KPIs werden verfolgt", "Operative Engpaesse und Massnahmen sind beschrieben"],
      FR: ["L utilisation de capacite est quantifiee", "Les KPI de service ou livraison sont suivis", "Les goulets operationnels et actions sont decrits"],
      IT: ["L utilizzo della capacita e quantificato", "I KPI di servizio o consegna sono monitorati", "I colli di bottiglia operativi e le azioni sono descritti"],
      ES: ["La utilizacion de capacidad esta cuantificada", "Se monitorean KPI de servicio o entrega", "Se describen cuellos de botella operativos y acciones"],
    },
  },
  {
    id: "doc_esg_assessment",
    pages: [24, 25],
    section: {
      EN: "ESG Assessment",
      DE: "ESG-Bewertung",
      FR: "Evaluation ESG",
      IT: "Valutazione ESG",
      ES: "Evaluacion ESG",
    },
    focus: {
      EN: "material sustainability risks",
      DE: "wesentliche Nachhaltigkeitsrisiken",
      FR: "risques de durabilite materiels",
      IT: "rischi di sostenibilita materiali",
      ES: "riesgos materiales de sostenibilidad",
    },
    points: {
      EN: ["Material ESG topics are prioritized", "Baseline indicators are reported", "Improvement roadmap is defined"],
      DE: ["Wesentliche ESG-Themen sind priorisiert", "Basisindikatoren sind berichtet", "Verbesserungs-Roadmap ist definiert"],
      FR: ["Les sujets ESG materiels sont priorises", "Les indicateurs de base sont rapportes", "La feuille de route d amelioration est definie"],
      IT: ["I temi ESG materiali sono prioritizzati", "Gli indicatori di base sono riportati", "La roadmap di miglioramento e definita"],
      ES: ["Los temas ESG materiales estan priorizados", "Los indicadores base estan reportados", "La hoja de ruta de mejora esta definida"],
    },
  },
  {
    id: "doc_risk_register",
    pages: [27, 28],
    section: {
      EN: "Risk Register",
      DE: "Risikoregister",
      FR: "Registre des risques",
      IT: "Registro dei rischi",
      ES: "Registro de riesgos",
    },
    focus: {
      EN: "top operational and strategic risks",
      DE: "wichtigste operative und strategische Risiken",
      FR: "principaux risques operationnels et strategiques",
      IT: "principali rischi operativi e strategici",
      ES: "principales riesgos operativos y estrategicos",
    },
    points: {
      EN: ["Risk likelihood and impact are scored", "Risk owners are assigned", "Mitigation status is reported"],
      DE: ["Eintrittswahrscheinlichkeit und Auswirkung sind bewertet", "Risikoeigentuemer sind zugewiesen", "Status der Massnahmen ist berichtet"],
      FR: ["La probabilite et l impact des risques sont notes", "Les proprietaires de risques sont attribues", "Le statut des mitigations est rapporte"],
      IT: ["Probabilita e impatto dei rischi sono valutati", "I responsabili dei rischi sono assegnati", "Lo stato delle mitigazioni e riportato"],
      ES: ["La probabilidad e impacto de riesgos estan evaluados", "Los propietarios de riesgo estan asignados", "El estado de mitigaciones esta reportado"],
    },
  },
  {
    id: "doc_customer_contracts",
    pages: [30, 31],
    section: {
      EN: "Customer Contracts",
      DE: "Kundenvertraege",
      FR: "Contrats clients",
      IT: "Contratti clienti",
      ES: "Contratos de clientes",
    },
    focus: {
      EN: "renewal risk and concentration",
      DE: "Verlaengerungsrisiko und Konzentration",
      FR: "risque de renouvellement et concentration",
      IT: "rischio di rinnovo e concentrazione",
      ES: "riesgo de renovacion y concentracion",
    },
    points: {
      EN: ["Top customers and contract share are listed", "Renewal timelines are identified", "Termination or penalty clauses are summarized"],
      DE: ["Top-Kunden und Vertragsanteile sind aufgefuehrt", "Verlaengerungszeitpunkte sind identifiziert", "Kuendigungs- oder Strafklauseln sind zusammengefasst"],
      FR: ["Les principaux clients et parts de contrat sont listes", "Les echeances de renouvellement sont identifiees", "Les clauses de resiliation ou penalites sont resumees"],
      IT: ["I principali clienti e le quote contrattuali sono elencati", "Le scadenze di rinnovo sono identificate", "Le clausole di recesso o penale sono riassunte"],
      ES: ["Los principales clientes y cuota contractual estan listados", "Los plazos de renovacion estan identificados", "Las clausulas de terminacion o penalizacion estan resumidas"],
    },
  },
];

const QUESTION_TEMPLATES: Record<EvaluationLanguage, Array<(section: string, focus: string) => string>> = {
  EN: [
    (section, focus) => `What does ${section} report about ${focus}?`,
    (section, focus) => `Summarize key evidence in ${section} for ${focus}.`,
    (section, focus) => `Which facts in ${section} support conclusions on ${focus}?`,
    (section, focus) => `What risks are highlighted in ${section} concerning ${focus}?`,
    (section, focus) => `Provide a due diligence answer from ${section} about ${focus}.`,
  ],
  DE: [
    (section, focus) => `Was berichtet der Abschnitt ${section} zu ${focus}?`,
    (section, focus) => `Fasse die wichtigsten Belege in ${section} fuer ${focus} zusammen.`,
    (section, focus) => `Welche Fakten in ${section} stuetzen Aussagen zu ${focus}?`,
    (section, focus) => `Welche Risiken werden in ${section} im Zusammenhang mit ${focus} genannt?`,
    (section, focus) => `Gib eine Due-Diligence-Antwort aus ${section} zu ${focus}.`,
  ],
  FR: [
    (section, focus) => `Que dit la section ${section} sur ${focus} ?`,
    (section, focus) => `Resume les preuves cles de ${section} concernant ${focus}.`,
    (section, focus) => `Quels faits dans ${section} soutiennent les conclusions sur ${focus} ?`,
    (section, focus) => `Quels risques sont signales dans ${section} au sujet de ${focus} ?`,
    (section, focus) => `Donne une reponse de due diligence depuis ${section} sur ${focus}.`,
  ],
  IT: [
    (section, focus) => `Cosa riporta la sezione ${section} su ${focus}?`,
    (section, focus) => `Riassumi le prove chiave in ${section} per ${focus}.`,
    (section, focus) => `Quali fatti in ${section} supportano le conclusioni su ${focus}?`,
    (section, focus) => `Quali rischi sono evidenziati in ${section} riguardo a ${focus}?`,
    (section, focus) => `Fornisci una risposta di due diligence da ${section} su ${focus}.`,
  ],
  ES: [
    (section, focus) => `Que informa la seccion ${section} sobre ${focus}?`,
    (section, focus) => `Resume la evidencia clave en ${section} para ${focus}.`,
    (section, focus) => `Que hechos en ${section} respaldan conclusiones sobre ${focus}?`,
    (section, focus) => `Que riesgos se destacan en ${section} en relacion con ${focus}?`,
    (section, focus) => `Da una respuesta de due diligence desde ${section} sobre ${focus}.`,
  ],
};

function parseArgs(argv: string[]): { outFile: string } {
  let outFile = "evaluation/evaluation_queries.json";

  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      outFile = argv[index + 1] ?? outFile;
      index += 1;
    }
  }

  return { outFile };
}

function generateDataset(): EvaluationQueryRecord[] {
  const records: EvaluationQueryRecord[] = [];

  for (const language of LANGUAGES) {
    for (const document of DOCUMENTS) {
      const templates = QUESTION_TEMPLATES[language];
      for (let templateIndex = 0; templateIndex < templates.length; templateIndex += 1) {
        const template = templates[templateIndex];
        if (!template) {
          continue;
        }

        records.push({
          id: `${language.toLowerCase()}-${document.id}-${String(templateIndex + 1).padStart(2, "0")}`,
          language,
          question: template(document.section[language], document.focus[language]),
          expected_document: document.id,
          expected_section: document.section[language],
          expected_pages: [...document.pages],
          acceptable_answer_points: [...document.points[language]],
        });
      }
    }
  }

  return records;
}

function summarizeByLanguage(records: EvaluationQueryRecord[]): Record<EvaluationLanguage, number> {
  const counts: Record<EvaluationLanguage, number> = {
    EN: 0,
    DE: 0,
    FR: 0,
    IT: 0,
    ES: 0,
  };

  for (const record of records) {
    counts[record.language] += 1;
  }

  return counts;
}

function run(): void {
  const args = parseArgs(process.argv);
  const outputPath = path.resolve(args.outFile);
  const dataset = generateDataset();
  const counts = summarizeByLanguage(dataset);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");

  console.log(`Generated evaluation dataset at: ${outputPath}`);
  console.log(`Total queries: ${dataset.length}`);
  console.log(
    `Language distribution: EN=${counts.EN}, DE=${counts.DE}, FR=${counts.FR}, IT=${counts.IT}, ES=${counts.ES}`,
  );
}

run();

