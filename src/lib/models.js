// Modèles d'embedding proposés. Les vecteurs sont rattachés à leur modèle : on ne mélange jamais deux espaces.
export const MODELS = {
  gemma1: {
    key: 'gemma1',
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    dim: 256, // Matryoshka : 768 tronqué à 256
    dtype: 'q8',
    label: 'EmbeddingGemma (300 M, texte)',
    imageModel: 'clip', // recherche d'images : CLIP (anglais)
  },
  gemma2: {
    key: 'gemma2',
    id: 'onnx-community/embeddinggemma-2-ONNX',
    dim: 768, // espace complet, non tronqué
    dtype: 'q4',
    label: 'EmbeddingGemma 2 (multimodal : texte + images)',
    imageModel: 'gemma2', // les images vivent dans le même espace que le texte
  },
};

export const DEFAULT_MODEL = 'gemma1';
export const modelOf = (key) => MODELS[key] || MODELS[DEFAULT_MODEL];
