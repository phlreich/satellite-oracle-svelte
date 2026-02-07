export type AssistRole = 'user' | 'assistant';

export type AssistMessage = {
	role: AssistRole;
	content: string;
};

export type AssistSelectionMode = 'replace' | 'add' | 'remove';

export type SceneContext = {
	selectedNoradId?: number | null;
	selectedInfoPanel?: string;
	visibleCount?: number;
};

export type AssistRequestBody = {
	messages: AssistMessage[];
	sceneContext?: SceneContext;
};

export type AssistVisibilityAction = {
	mode: AssistSelectionMode;
	noradCatIds: number[];
	returnedCount: number;
};

export type AssistFocusAction =
	| {
			target: 'earth';
	  }
	| {
			target: 'norad';
			noradCatId: number;
	  };

export type AssistSceneAction = {
	visibility?: AssistVisibilityAction;
	focus?: AssistFocusAction;
};

export type AssistResponse = {
	assistantMessage: string;
	action: AssistSceneAction | null;
};
