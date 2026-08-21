export interface ExampleFeatureConfig {
  enabledByDefault?: boolean;
  notePrefix?: string;
}

export interface ExampleFeatureToolResult {
  enabled: boolean;
  counter: number;
  lastInput: string;
  notes: string[];
  injected?: {
    enabled: boolean;
    counter: number;
  };
}

export interface ExampleFeatureRuntimeState {
  enabled: boolean;
  counter: number;
  lastInput: string;
  notes: string[];
}

export interface ExampleFeatureSnapshot {
  enabled: boolean;
  counter: number;
  lastInput: string;
  notes: string[];
}
