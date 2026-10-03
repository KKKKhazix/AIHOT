// Order-constrained weighted least squares on observed pair differences. The fit supplies a
// readable index without changing Kemeny positions or treating missing evidence as a zero result.
import { highsRuntime } from './kemeny.ts';

export const SCORE_VERSION = '2026.10-pairwise-fit-v1';
export interface ScoreFit {
  version: string;
  optimal: boolean;
  anchors: string[];
  scores: Array<number | null>;
  latent: number[];
  weightedRmse: number | null;
}
interface EvidenceMatrix { models: string[]; M: Float64Array[]; W: Float64Array[] }

/** Minimise Σ W_ij (x_i-x_j-M_ij/W_ij)^2, x follows order, mean(anchor x)=0.
 * 100/(1+9^(-x)) maps that declared reference centre to 50 and ±1 to 90/10.
 * It is an index, never a probability. Ratings are comparable within one board and run. */
export async function fitScores({models,M,W}: EvidenceMatrix, order: number[], anchorSlugs: string[]): Promise<ScoreFit> {
  const n=models.length, anchors=[...new Set(anchorSlugs)].filter(a=>models.includes(a)).sort();
  const empty:ScoreFit={version:SCORE_VERSION,optimal:false,anchors,scores:Array(n).fill(null),latent:[],weightedRmse:null};
  if (!n || !anchors.length) return empty;
  if(order.length!==n || new Set(order).size!==n || order.some(i=>!Number.isInteger(i)||i<0||i>=n)) throw new Error('Invalid score order');
  const seen=new Set([0]), stack=[0];
  let largestWeight=0;
  for(let i=0;i<n;i++) for(let j=0;j<n;j++) {
    if(!Number.isFinite(M[i]?.[j])||!Number.isFinite(W[i]?.[j])||W[i]![j]!<0
      || Math.abs(M[i]![j]!+M[j]![i]!)>1e-9 || Math.abs(W[i]![j]!-W[j]![i]!)>1e-9
      || (W[i]![j]===0 && M[i]![j]!==0)) throw new Error('Invalid score evidence');
    if(i!==j) largestWeight=Math.max(largestWeight,W[i]![j]!);
  }
  while(stack.length) {
    const i=stack.pop()!;
    for(let j=0;j<n;j++) if(W[i]![j]!>0 && !seen.has(j)) {seen.add(j);stack.push(j);}
  }
  if(seen.size!==n) return empty;
  if(n===1) return {...empty,optimal:true,scores:[50],latent:[0],weightedRmse:0};
  const highs=await highsRuntime();
  const cost=new Float64Array(n), diagonal=new Float64Array(n);
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) {
    const w=W[i]![j]!/largestWeight, m=M[i]![j]!/largestWeight;
    diagonal[i]!+=2*w; diagonal[j]!+=2*w;
    cost[i]!-=2*m; cost[j]!+=2*m;
  }
  const starts=[0], indices:number[]=[], values:number[]=[];
  for(let col=0;col<n;col++) {
    indices.push(col); values.push(diagonal[col]!);
    for(let row=col+1;row<n;row++) if(W[row]![col]!>0) {indices.push(row);values.push(-2*W[row]![col]!/largestWeight);}
    starts.push(indices.length);
  }
  const model=highs.createModel({numCols:n,numRows:0,colCost:cost,
    colLower:Array(n).fill(-highs.infinity),colUpper:Array(n).fill(highs.infinity),
    rowLower:[],rowUpper:[],matrix:{format:'csr',numRows:0,numCols:n,starts:[0],indices:[],values:[]},
    hessian:{format:'triangular',dimension:n,starts,indices,values},
  });
  try {
    model.options.set({output_flag:false,time_limit:15,primal_feasibility_tolerance:1e-9,dual_feasibility_tolerance:1e-9,qp_regularization_value:0});
    model.addRow(0,0,{indices:anchors.map(a=>models.indexOf(a)),values:anchors.map(()=>1/anchors.length)});
    for(let i=0;i<n-1;i++) model.addRow(0,highs.infinity,{indices:[order[i]!,order[i+1]!],values:[1,-1]});
    model.run();
    if(model.getModelStatus()!==highs.constants.modelStatus.optimal) return empty;
    const latent=Array.from(model.getSolution().colValue);
    if(latent.some(x=>!Number.isFinite(x)) || order.some((i,p)=>p>0 && latent[i]!>latent[order[p-1]!]!+1e-7)) return empty;
    const centre=anchors.reduce((sum,a)=>sum+latent[models.indexOf(a)]!,0)/anchors.length;
    if(Math.abs(centre)>1e-7) return empty;
    const scores=latent.map(x=>100/(1+Math.exp(-Math.log(9)*x)));
    // Remove only solver-scale ordering noise; never invent visible gaps between tied scores.
    for(let p=1;p<n;p++) scores[order[p]!] = Math.min(scores[order[p]!]!,scores[order[p-1]!]!);
    let error=0,weight=0;
    for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) if(W[i]![j]!>0) {
      error+=W[i]![j]!*(latent[i]!-latent[j]!-M[i]![j]!/W[i]![j]!)**2; weight+=W[i]![j]!;
    }
    return {version:SCORE_VERSION,optimal:true,anchors,scores,latent,weightedRmse:Math.sqrt(error/weight)};
  } finally {model.dispose();}
}
