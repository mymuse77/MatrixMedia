var express = require('express');
const { changeData} = require('../utils');
const { getClientIdentity } = require('../../services/clientIdentity');
var router = express.Router();


/* GET home page. */
router.get('/', function(req, res, next) {
  res.send('<h1>Express</h1>'); 
});


/* GET home page. */
router.post('/changeData', function(req, res) {
  res.send(changeData({...req.body})); 
});

router.get('/client-id', function(req, res) {
  const identity = getClientIdentity();
  res.send({
    success: true,
    clientId: identity.clientId,
    clientType: 'matrix_pc_client',
    createdAt: identity.createdAt,
  });
});

router.get('/clientId', function(req, res) {
  const identity = getClientIdentity();
  res.send({
    success: true,
    clientId: identity.clientId,
    clientType: 'matrix_pc_client',
    createdAt: identity.createdAt,
  });
});



module.exports = router;
