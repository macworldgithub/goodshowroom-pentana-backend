import type { SalesLead } from '../database/models.js';
export const PIPELINE_STAGES = ['new', 'contacted', 'appointment', 'appraisal', 'quote', 'order', 'awaiting_delivery', 'delivered', 'qualified', 'test_drive', 'negotiation', 'won', 'lost', 'closed'] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];
export function pipelineStage(lead: Pick<SalesLead, 'pipeline_stage' | 'status'>): PipelineStage {
  return lead.pipeline_stage ?? lead.status;
}
export function enquiryStatus(stage: PipelineStage): SalesLead['status'] {
  return ['won', 'lost', 'closed', 'delivered'].includes(stage) ? 'closed' : ['appointment', 'appraisal', 'quote', 'order', 'awaiting_delivery', 'test_drive', 'negotiation'].includes(stage) ? 'qualified' : stage as SalesLead['status'];
}
