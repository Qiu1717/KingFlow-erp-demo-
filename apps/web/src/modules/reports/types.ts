export type Kind = 'sales' | 'purchases' | 'inventory' | 'finance';
export interface ReportRow {
  id: string;
  number: string;
  date: string;
  partner: string;
  product: string;
  warehouse: string;
  quantity: number;
  openingQuantity?: number;
  inboundQuantity?: number;
  outboundQuantity?: number;
  amount: number;
  settled: number;
  balance: number;
  sourcePath: string;
}
export interface Report {
  items: ReportRow[];
  total: number;
  totals: {
    quantity: number;
    amount: number;
    settled: number;
    balance: number;
  };
  analysis: {
    trend: AnalysisRow[];
    productRanking: AnalysisRow[];
    partnerRanking: AnalysisRow[];
    warehouseSummary: AnalysisRow[];
    financeSummary: {
      name: string;
      amount: number;
      settled: number;
      balance: number;
    }[];
    stockAlerts?: { total: number };
    movements?: {
      id: string;
      number: string;
      quantity: number;
      type: string;
      createdAt: string;
    }[];
  };
}
export interface AnalysisRow {
  name: string;
  amount: number;
  quantity: number;
}
