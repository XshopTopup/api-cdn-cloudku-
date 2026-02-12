const shortKu = async (originalUrl, customName = null) => {
  const endpoint = 'https://shortku.biz.id/shorten';
  const payload = {
    originalUrl: originalUrl
  };

  if (customName && customName.trim() !== "") {
    payload.customName = customName;
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Terjadi kesalahan saat memperpendek URL');
    }

    return result;
  } catch (error) {
    console.error('Error Shorten:', error.message);
    return { 
      success: false, 
      message: error.message 
    };
  }
};

module.exports = shortKu;
