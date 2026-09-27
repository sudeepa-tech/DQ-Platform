const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api';

function getToken() {
  return localStorage.getItem('dq_token');
}

async function request(path, { method = 'GET', body, isForm = false, headers = {} } = {}) {
  const token = getToken();
  const finalHeaders = { ...headers };
  if (!isForm) finalHeaders['Content-Type'] = 'application/json';
  if (token) finalHeaders['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: finalHeaders,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });

  if (res.status === 401) {
    localStorage.removeItem('dq_token');
    localStorage.removeItem('dq_user');
    window.location.href = '/login';
    throw new Error('Session expired.');
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const err = new Error((data && data.error) || 'Request failed.');
    // Preserve structured error fields from the API's JSON body (e.g. review_required, files, unresolved) onto the
    // thrown Error so callers can branch on them instead of string-matching the message.
    if (data && typeof data === 'object') Object.assign(err, data);
    throw err;
  }
  return data;
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/auth/me'),

  listDatasets: () => request('/datasets'),
  createDataset: (payload) => request('/datasets', { method: 'POST', body: payload }),
  getDataset: (id) => request(`/datasets/${id}`),
  uploadFile: (datasetId, formData) => request(`/datasets/${datasetId}/files`, { method: 'POST', body: formData, isForm: true }),
  selectSheets: (datasetId, fileId, sheetNames) => request(`/datasets/${datasetId}/files/${fileId}/select-sheet`, { method: 'POST', body: { sheet_names: sheetNames } }),
  deleteFile: (datasetId, fileId) => request(`/datasets/${datasetId}/files/${fileId}`, { method: 'DELETE' }),
  analyzeDataset: (datasetId) => request(`/datasets/${datasetId}/analyze`, { method: 'POST' }),
  getDatasetStatus: (datasetId) => request(`/datasets/${datasetId}/status`),
  analyzeDatasetGated: (datasetId, body = {}) => request(`/datasets/${datasetId}/analyze`, { method: 'POST', body: { require_manual_review: true, ...body } }),

  getSchemaReview: (sourceFileId, version) => request(`/schema/sources/${sourceFileId}${version ? `?version=${version}` : ''}`),
  suggestSchema: (sourceFileId, force = false) => request(`/schema/sources/${sourceFileId}/suggest`, { method: 'POST', body: { force } }),
  setDatasetType: (sourceFileId, version, datasetType, note) => request(`/schema/sources/${sourceFileId}/versions/${version}/dataset-type`, { method: 'PATCH', body: { dataset_type: datasetType, note } }),
  overrideColumn: (sourceFileId, version, fileColumnId, changes) => request(`/schema/sources/${sourceFileId}/versions/${version}/columns/${fileColumnId}`, { method: 'PATCH', body: changes }),
  confirmSchema: (sourceFileId, version, acceptSuggestions = false) => request(`/schema/sources/${sourceFileId}/versions/${version}/confirm`, { method: 'POST', body: { accept_suggestions: acceptSuggestions } }),
  reviseSchema: (sourceFileId, version, note) => request(`/schema/sources/${sourceFileId}/versions/${version}/revise`, { method: 'POST', body: { note } }),
  planRerun: (runId, payload) => request(`/runs/${runId}/plan-rerun`, { method: 'POST', body: payload }),

  getRun: (runId) => request(`/runs/${runId}`),
  listRuns: (params = {}) => request(`/runs?${new URLSearchParams(params)}`),
  getDashboard: (runId) => request(`/runs/${runId}/dashboard`),
  getFieldProfiles: (runId) => request(`/runs/${runId}/field-profiles`),
  getIssues: (runId, params = {}) => request(`/runs/${runId}/issues?${new URLSearchParams(params)}`),
  getIssueFields: (runId) => request(`/runs/${runId}/issues/fields`),
  getClusters: (runId, params = {}) => request(`/runs/${runId}/clusters?${new URLSearchParams(params)}`),
  getClusterDetail: (runId, clusterId) => request(`/runs/${runId}/clusters/${clusterId}`),
  getMatchSummary: (runId) => request(`/runs/${runId}/match-summary`),
  getConflicts: (runId) => request(`/runs/${runId}/conflicts`),
  getPairs: (runId, params = {}) => request(`/runs/${runId}/pairs?${new URLSearchParams(params)}`),
  getRunRecords: (runId, params = {}) => request(`/runs/${runId}/records?${new URLSearchParams(params)}`),
  getFieldIssueSummary: (runId, params = {}) => request(`/runs/${runId}/field-issue-summary?${new URLSearchParams(params)}`),
  getFreshness: (runId) => request(`/runs/${runId}/freshness`),
  getRunExports: (runId) => request(`/runs/${runId}/exports`),

  getRecord: (id) => request(`/records/${id}`),

  createExport: (runId, exportType, format) => request(`/runs/${runId}/export`, { method: 'POST', body: { export_type: exportType, format } }),
  downloadExport: async (exportId, suggestedName) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/exports/${exportId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new Error('Download failed.');
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : (suggestedName || 'export');
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    window.URL.revokeObjectURL(url);
  },

  getToken
};
